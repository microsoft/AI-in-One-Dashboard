// @ts-check
/**
 * App client secrets kept in the install record from before Entra is asked for one until Entra
 * confirms it's removed, so a run that stops part-way never leaves one nobody knows about.
 *
 * Each use of a secret (the Key Vault secret, the model's connection, the Azure SQL reader) has a
 * slot in the record:
 * - secretAttempts: asked of Entra, key ID not saved yet. The ref is in the secret's name, so the
 *   next run can find it. Its value was never saved, so nothing holds it.
 * - pendingSecretKeyIds: made, and maybe already stored or in use, but not yet confirmed as the
 *   one in use. Never removed while that's unknown: a newer secret replaces it first.
 * - secretKeyId: the one in use.
 * - retiredSecretKeyIds: no longer used, and stays listed until Entra confirms it's removed.
 */
import { randomBytes } from 'node:crypto';
import { HttpError } from '../http.js';

/** @typedef {import('../install.js').Ctx} Ctx */

/**
 * @typedef {object} SecretSlot
 * @property {string} [secretKeyId]
 * @property {{ ref: string, at: string }[]} [secretAttempts]
 * @property {string[]} [pendingSecretKeyIds]
 * @property {string[]} [retiredSecretKeyIds]
 * @property {string[]} [previousSecretKeyIds]  Replaced, but kept on the app because a run may still use it (Key Vault).
 */

/** How long after asking Entra for a secret a run waits before saying none by that name is on the app. */
export const SECRET_SETTLE_MS = 10 * 60_000;

/** A secret's name on the app, with the ref of the run that asked for it. @param {string} label @param {string} ref */
export const withSecretRef = (label, ref) => `${label} (ref ${ref})`;

/** An answer that means the request wasn't carried out, so nothing was made or stored. @param {unknown} err */
export const refused = (err) => err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408;

/** @param {(string | undefined)[]} keys */
const uniq = (keys) => /** @type {string[]} */ ([...new Set(keys.filter(Boolean))]);

/** @param {SecretSlot} slot @param {'secretAttempts' | 'pendingSecretKeyIds' | 'retiredSecretKeyIds' | 'previousSecretKeyIds'} field */
function tidy(slot, field) {
  if (!slot[field]?.length) delete slot[field];
}

/** @param {SecretSlot} slot @param {string} ref */
export function dropAttempt(slot, ref) {
  if (!slot.secretAttempts) return;
  slot.secretAttempts = slot.secretAttempts.filter((a) => a.ref !== ref);
  tidy(slot, 'secretAttempts');
}

/**
 * Looks on the app for the secrets runs that stopped part-way asked for, by the exact name with
 * each run's ref. Returns those the record doesn't track yet, and drops their attempts; the caller
 * records them in the same save. An attempt with no match is kept, since Entra may still show
 * the secret later, and from SECRET_SETTLE_MS on each run says so. More than one match, or a
 * failed lookup, keeps the attempt and warns.
 * @param {Ctx} ctx
 * @param {SecretSlot} slot
 * @param {string | undefined} objectId  The app registration's object ID.
 * @param {string} label
 * @returns {Promise<string[]>}
 */
export async function findAttempts(ctx, slot, objectId, label) {
  const { ui, api } = ctx;
  if (!slot.secretAttempts?.length || !objectId) return [];
  /** @type {{ keyId: string, displayName?: string }[]} */
  let creds;
  try {
    creds = await api.graph.listPasswords(objectId);
  } catch (err) {
    ui.warn(`Couldn't check the app for a client secret a stopped run may have added (${/** @type {Error} */ (err).message}). It's checked again next run.`);
    return [];
  }
  const tracked = new Set([slot.secretKeyId, ...(slot.pendingSecretKeyIds ?? []), ...(slot.retiredSecretKeyIds ?? []), ...(slot.previousSecretKeyIds ?? [])]);
  /** @type {string[]} */
  const found = [];
  for (const attempt of [...slot.secretAttempts]) {
    const name = withSecretRef(label, attempt.ref);
    const matches = creds.filter((c) => c.displayName === name);
    if (matches.length > 1) {
      ui.warn(`More than one client secret on the app is called "${name}" (keys ${matches.map((c) => c.keyId).join(', ')}), so none is removed. Check them on the app's Certificates & secrets page.`);
      continue;
    }
    if (matches.length === 1) {
      if (!tracked.has(matches[0].keyId)) found.push(matches[0].keyId);
      dropAttempt(slot, attempt.ref);
    } else if (!(ctx.now().getTime() - Date.parse(attempt.at) < SECRET_SETTLE_MS)) {
      ui.warn(`A run that stopped part-way asked Entra for a client secret called "${name}" (at ${attempt.at}), and the app has none by that name. The install record keeps watching for it in case Entra did make it, and a later run removes or adopts it if it appears. Nothing needs doing otherwise.`);
    }
  }
  return found;
}

/**
 * For a secret whose value may already be stored or in use: one a stopped run made is kept as
 * pending, so it's removed only once a newer one has replaced it.
 * @param {Ctx} ctx
 * @param {SecretSlot} slot
 * @param {string | undefined} objectId
 * @param {string} label
 */
export async function adoptAttempts(ctx, slot, objectId, label) {
  if (!slot.secretAttempts?.length) return;
  const found = await findAttempts(ctx, slot, objectId, label);
  if (found.length) {
    slot.pendingSecretKeyIds = uniq([...(slot.pendingSecretKeyIds ?? []), ...found]);
    ctx.ui.warn(`A run that stopped part-way added a client secret to the app (key ${found.join(', ')}) without recording it. It's recorded now, and removed once a newer one is in use.`);
  }
  ctx.save();
}

/**
 * Adds a client secret to the app. A ref is saved before Entra is asked and goes in the secret's
 * name; the key ID replaces it, as pending, in one save before the value is used anywhere.
 * @param {Ctx} ctx
 * @param {SecretSlot} slot
 * @param {string} objectId
 * @param {string} label
 * @param {Date} end
 * @returns {Promise<{ keyId: string, secretText: string, endDateTime: string }>}
 */
export async function addTrackedSecret(ctx, slot, objectId, label, end) {
  await adoptAttempts(ctx, slot, objectId, label);
  const ref = randomBytes(6).toString('hex');
  slot.secretAttempts = [...(slot.secretAttempts ?? []), { ref, at: ctx.now().toISOString() }];
  ctx.save();
  let cred;
  try {
    cred = await ctx.api.graph.addPassword(objectId, end, withSecretRef(label, ref));
  } catch (err) {
    if (refused(err)) {
      dropAttempt(slot, ref);
      ctx.save();
    }
    throw err;
  }
  slot.pendingSecretKeyIds = uniq([...(slot.pendingSecretKeyIds ?? []), cred.keyId]);
  dropAttempt(slot, ref);
  ctx.save();
  return cred;
}

/**
 * The new secret is now the one in use. The one before and any still pending are moved, in the
 * same save, to retired (then removed) or, with keepPrevious, to previous (left on the app).
 * Callers set the record's other fields first, so they're saved together.
 * @param {Ctx} ctx
 * @param {SecretSlot} slot
 * @param {string | undefined} objectId
 * @param {string | undefined} keyId  Undefined when the user pasted the secret.
 * @param {{ keepPrevious?: boolean }} [o]
 * @returns {Promise<string[]>}  The secrets it replaced.
 */
export async function promoteSecret(ctx, slot, objectId, keyId, o = {}) {
  const replaced = uniq([slot.secretKeyId, ...(slot.pendingSecretKeyIds ?? [])]).filter((k) => k !== keyId);
  if (keyId) slot.secretKeyId = keyId;
  else delete slot.secretKeyId;
  delete slot.pendingSecretKeyIds;
  const field = o.keepPrevious ? 'previousSecretKeyIds' : 'retiredSecretKeyIds';
  if (replaced.length) slot[field] = uniq([...(slot[field] ?? []), ...replaced]);
  ctx.save();
  if (!o.keepPrevious) await removeRetired(ctx, slot, objectId);
  return replaced;
}

/**
 * A secret whose value definitely wasn't stored anywhere: removed now, or kept as retired to
 * remove later if Entra won't.
 * @param {Ctx} ctx
 * @param {SecretSlot} slot
 * @param {string | undefined} objectId
 * @param {string} keyId
 * @returns {Promise<boolean>}  Whether it's gone.
 */
export async function discardSecret(ctx, slot, objectId, keyId) {
  slot.retiredSecretKeyIds = uniq([...(slot.retiredSecretKeyIds ?? []), keyId]);
  slot.pendingSecretKeyIds = slot.pendingSecretKeyIds?.filter((k) => k !== keyId);
  tidy(slot, 'pendingSecretKeyIds');
  ctx.save();
  await removeRetired(ctx, slot, objectId);
  return !slot.retiredSecretKeyIds?.includes(keyId);
}

/**
 * After the value was handed to something that failed: if it was turned down, nothing holds the
 * secret and it's removed. Otherwise it may be stored, so it stays pending and a later run that
 * replaces it removes it.
 * @param {Ctx} ctx
 * @param {SecretSlot} slot
 * @param {string | undefined} objectId
 * @param {string} keyId
 * @param {unknown} err
 * @returns {Promise<'removed' | 'retired' | 'kept'>}
 */
export async function settleFailedSecret(ctx, slot, objectId, keyId, err) {
  if (refused(err)) return (await discardSecret(ctx, slot, objectId, keyId)) ? 'removed' : 'retired';
  ctx.ui.warn(`The new client secret (key ${keyId}) may have been stored before the error, so it stays on the app and in the install record. The next run replaces it and then removes it.`);
  return 'kept';
}

/**
 * Removes the slot's retired secrets. Each stays listed until Entra confirms it's gone.
 * @param {Ctx} ctx
 * @param {SecretSlot} slot
 * @param {string | undefined} objectId
 */
export async function removeRetired(ctx, slot, objectId) {
  if (!slot.retiredSecretKeyIds?.length || !objectId) return;
  /** @type {Set<string> | undefined} */
  let onApp;
  for (const keyId of [...slot.retiredSecretKeyIds]) {
    let removed = await ctx.api.graph.removePassword(objectId, keyId).then(
      () => true,
      () => false,
    );
    if (!removed) {
      // A run that stopped after removing it gets an error now; the app's own list says if it's gone.
      onApp ??= await ctx.api.graph.listPasswords(objectId).then(
        (creds) => new Set(creds.map((c) => c.keyId)),
        () => undefined,
      );
      removed = !!onApp && !onApp.has(keyId);
    }
    if (!removed) {
      ctx.ui.warn(`Couldn't remove a previous client secret (key ${keyId}) from the app. It stays in the install record and the next run tries again, or delete it from the app's Certificates & secrets page.`);
      continue;
    }
    slot.retiredSecretKeyIds = slot.retiredSecretKeyIds?.filter((k) => k !== keyId);
    tidy(slot, 'retiredSecretKeyIds');
    ctx.save();
  }
}
