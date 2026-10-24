// @ts-check
/**
 * The PAX route's app registration: the Microsoft Graph permissions PAX reads the audit log and
 * the users with, Sites.Selected for the one SharePoint site, and the certificate (or, where this
 * PC can't make one, the client secret) the scheduled task signs in with.
 */
import { existsSync, rmSync } from 'node:fs';
import { GRAPH_APP_ID, paxPermissions, paxUnneeded } from '../catalog.js';
import { apiPermissionsUrl, resolveAppRoles } from '../clients/graph.js';
import { HttpError } from '../http.js';
import { commandLine } from '../launch.js';
import { addMonths, graphRoles } from '../steps/identity.js';
import { CERT_MONTHS, PAX_APP_NAME, secretPath } from './names.js';
import { runPwshOf } from './pc.js';
import { inspectCertificate, makeCertificate, protectSecret, removeCertificate } from './scripts.js';

export { AGENT365_PERMISSIONS, PAX_PERMISSIONS, paxPermissions, paxUnneeded } from '../catalog.js';

/** @typedef {import('../install.js').Ctx} Ctx */

/** A certificate or secret with fewer days left than this is replaced. */
export const RENEW_DAYS = 30;

/** The choice for an app registration someone else made, with the user as an owner. */
export const OWN_APP = 'Use an app registration I own already';

/** What the app is for, on its Overview page in Entra. */
export const PAX_APP_NOTES =
  'Created by the AI in One installer. A scheduled task on one PC signs in as this app to run PAX, which reads the Copilot audit log and users from Microsoft Graph, and to upload the files to one SharePoint site it was given access to.';

/** @param {unknown} err */
const forbidden = (err) => err instanceof HttpError && err.status === 403;

/** @param {Ctx} ctx */
function paxOf(ctx) {
  const pax = ctx.config.pax;
  if (!pax) throw new Error('The install record has no PAX setup.');
  return pax;
}

/**
 * Graph's service principal and the app roles the PAX route needs. The same cache the shared
 * consent and app checks read, keyed by the permissions, so turning Agent 365 on or off looks
 * them up again.
 * @param {Ctx} ctx
 */
export const paxGraphRoles = (ctx) => graphRoles(ctx);

/**
 * Creates "AI in One (PAX)" and its service principal, or adopts the app registration in the
 * install record. It has no client secret unless the certificate can't be used.
 * @param {Ctx} ctx
 */
export async function ensurePaxApp(ctx) {
  const { ui, config, api } = ctx;
  const app = config.app;
  const { roles } = await paxGraphRoles(ctx);
  const names = roles.map((r) => r.value).join(', ');

  if (app.appId) {
    const application = await api.graph.findApplication(app.appId);
    if (!application) {
      throw new Error(
        app.existing
          ? `No app registration with ID ${app.appId} in this tenant, or you aren't one of its owners.`
          : `The app registration ${app.appId} in the install record no longer exists. Delete the "app" section of the install record to create a new one.`,
      );
    }
    app.objectId = application.id;
    app.displayName = application.displayName;
    try {
      if (await api.graph.ensureRequiredAccess(application, roles)) ui.ok('Added the permissions PAX needs to its API permissions');
    } catch (err) {
      if (!forbidden(err)) throw err;
      ui.warn(`You can't edit ${application.displayName}'s API permissions. An admin must add these Graph application permissions: ${names}.`);
    }
    ui.ok(`Using app registration "${application.displayName}" (${app.appId})`);
  } else {
    /** @type {any} */
    let application;
    try {
      application = await api.graph.createApplication(PAX_APP_NAME, roles, PAX_APP_NOTES);
    } catch (err) {
      if (!forbidden(err)) throw err;
      throw new Error(
        `You can't create app registrations in this tenant. Ask an admin to create "${PAX_APP_NAME}" with the Graph application permissions ${names}, ` +
          `and to make you one of its owners. Then run the installer again and choose "${OWN_APP}".`,
      );
    }
    app.appId = application.appId;
    app.objectId = application.id;
    app.displayName = application.displayName;
    app.existing = false;
    app.permissions = paxPermissions(paxOf(ctx));
    ctx.save();
    ui.ok(`Created app registration "${PAX_APP_NAME}" (${app.appId})`);
  }

  if (!app.servicePrincipalId) {
    const appId = /** @type {string} */ (app.appId);
    let sp = await api.graph.findServicePrincipal(appId);
    if (!sp) {
      sp = await api.graph.createServicePrincipal(appId);
      ui.ok('Created its service principal');
    }
    app.servicePrincipalId = sp.id;
  }
  ctx.save();
}

/**
 * Takes the Graph permissions this setup no longer needs off the installer's app: the Agent 365
 * pair once it's off, and Sites.Selected once the files stay on the PC. They come off its API
 * permissions, and their admin consent goes when the signed-in user can take it away; otherwise
 * the installer says who can. An app the user brought keeps them: the installer says which ones
 * this setup doesn't use. Only the permissions an earlier setup may have asked for are looked at.
 * @param {Ctx} ctx
 * @param {{ canConsent: boolean }} who
 */
export async function dropUnneededPermissions(ctx, who) {
  const { ui, config, api } = ctx;
  const app = config.app;
  const pax = paxOf(ctx);
  const done = () => {
    app.permissions = paxPermissions(pax);
    ctx.save();
  };
  const names = paxUnneeded(pax).filter((p) => !app.permissions || app.permissions.includes(p));
  if (!names.length || !app.appId || !app.servicePrincipalId) return done();
  const appId = app.appId;
  const spId = app.servicePrincipalId;
  const { sp: graphSp } = await paxGraphRoles(ctx);
  const roles = resolveAppRoles(graphSp, names, names).roles;
  const application = await api.graph.findApplication(appId);
  const entry = /** @type {any[]} */ (application?.requiredResourceAccess ?? []).find((r) => r.resourceAppId === GRAPH_APP_ID);
  const declared = roles.filter((r) => /** @type {any[]} */ (entry?.resourceAccess ?? []).some((a) => a.id === r.id));
  const assigned = (await api.graph.appRoleAssignments(spId)).filter((a) => a.resourceId === graphSp.id && roles.some((r) => r.id === a.appRoleId));
  const extra = roles.filter((r) => declared.includes(r) || assigned.some((a) => a.appRoleId === r.id)).map((r) => r.value);
  if (!extra.length) return done();
  const name = app.displayName ?? appId;
  if (app.existing) {
    ui.note(`"${name}" has Graph application permissions this setup doesn't use: ${extra.join(', ')}. You can remove them, and their admin consent, on its API permissions page:`);
    ui.info(apiPermissionsUrl(appId));
    return done();
  }

  let left = false;
  if (declared.length) {
    const list = declared.map((r) => r.value).join(', ');
    try {
      await api.graph.removeRequiredAccess(application, declared.map((r) => r.id));
      ui.ok(`Took the permissions this setup no longer needs off its API permissions: ${list}`);
    } catch (err) {
      if (!forbidden(err)) throw err;
      left = true;
      ui.warn(`You can't change the API permissions of "${name}". An admin can remove these, which this setup no longer needs: ${list}.`);
    }
  }
  if (assigned.length) {
    const list = roles.filter((r) => assigned.some((a) => a.appRoleId === r.id)).map((r) => r.value).join(', ');
    let gone = false;
    if (who.canConsent) {
      try {
        for (const a of assigned) await api.graph.deleteAppRoleAssignment(spId, a.id);
        gone = true;
        ui.ok(`Took away the admin consent this setup no longer needs: ${list}`);
      } catch (err) {
        if (!forbidden(err)) throw err;
      }
    }
    if (!gone) {
      left = true;
      ui.warn(`The admin consent for ${list} stays, though this setup no longer needs it. A Global Administrator or Privileged Role Administrator can take it away.`);
    }
  }
  if (!left) return done();
  ui.info('They can do it on the app\'s API permissions page:');
  ui.info(apiPermissionsUrl(appId));
}

/**
 * Days from `now` until `iso`. NaN when it isn't a date.
 * @param {string | undefined} iso
 * @param {Date} now
 */
export const daysLeft = (iso, now) => (Date.parse(iso ?? '') - now.getTime()) / 86_400_000;

/** @param {string | undefined} iso */
const day = (iso) => String(iso ?? '').slice(0, 10);

/**
 * Whether the task can keep signing in the way it does now.
 * @param {Ctx} ctx
 * @param {string[]} onApp  The certificates', or the secrets', key IDs on the app.
 */
async function stillGood(ctx, onApp) {
  const pax = paxOf(ctx);
  const now = ctx.now();
  if (pax.credentialType === 'secret') {
    return !!pax.secretKeyId && onApp.includes(pax.secretKeyId) && existsSync(secretPath(ctx.env)) && daysLeft(pax.secretExpires, now) >= RENEW_DAYS;
  }
  if (!pax.certificateThumbprint || !pax.certificateKeyId || !onApp.includes(pax.certificateKeyId)) return false;
  const cert = await inspectCertificate(runPwshOf(ctx), pax.certificateThumbprint).catch(() => ({ exists: false, hasPrivateKey: false, notAfter: undefined }));
  return cert.exists && !!cert.hasPrivateKey && daysLeft(cert.notAfter, now) >= RENEW_DAYS;
}

/**
 * The key IDs on the app the task's current credential would be among.
 * @param {Ctx} ctx
 * @param {string} objectId
 */
async function keysOnApp(ctx, objectId) {
  const pax = paxOf(ctx);
  return pax.credentialType === 'secret'
    ? (await ctx.api.graph.listPasswords(objectId)).map((p) => p.keyId)
    : (await ctx.api.graph.keyCredentials(objectId)).map((k) => String(k.keyId));
}

/**
 * Moves the task's current credential to the retired list, to come off the app once the task's
 * script has been written with the new one.
 * @param {import('../config.js').PaxConfig} pax
 */
function retireCurrent(pax) {
  const retired = new Set(pax.retiredKeyIds ?? []);
  for (const id of [pax.certificateKeyId, pax.secretKeyId]) if (id) retired.add(id);
  pax.retiredKeyIds = [...retired];
  if (pax.certificateThumbprint) pax.retiredThumbprints = [...new Set([...(pax.retiredThumbprints ?? []), pax.certificateThumbprint])];
  delete pax.certificateKeyId;
  delete pax.certificateThumbprint;
  delete pax.certificateExpires;
  delete pax.secretKeyId;
  delete pax.secretExpires;
}

/**
 * The credential the scheduled task signs in with. A certificate made in this user's store, whose
 * private key can't leave this PC, with its public key on the app. It's kept while it has a month
 * left and is still on the app. Where this PC can't make one, a client secret takes its place,
 * protected with Windows for this user on this PC; the installer keeps no copy.
 * @param {Ctx} ctx
 * @param {{ force?: boolean, certificates?: boolean }} [o]  force: replace it even when it's still good (rotate-secret).
 *   certificates: false when the PC check found it can't make certificates.
 * @returns {Promise<boolean>} whether the credential changed, so the task's script needs writing again
 */
export async function ensureCredential(ctx, o = {}) {
  const { ui, config, api } = ctx;
  const pax = paxOf(ctx);
  const objectId = /** @type {string} */ (config.app.objectId);
  if (!objectId) throw new Error('The install record has no app registration yet.');
  const runPwsh = runPwshOf(ctx);

  if (!o.force && (await stillGood(ctx, await keysOnApp(ctx, objectId)))) {
    ui.ok(
      pax.credentialType === 'secret'
        ? `The task signs in with its client secret, protected for you on this PC (until ${day(pax.secretExpires)})`
        : `The task signs in with its certificate (until ${day(pax.certificateExpires)})`,
    );
    return false;
  }

  /** @type {Error | undefined} */
  let certFailed;
  if (o.certificates !== false) {
    /** @type {import('./scripts.js').Certificate | undefined} */
    let cert;
    try {
      cert = await makeCertificate(runPwsh, CERT_MONTHS);
      if (!cert.hasPrivateKey) throw new Error('Windows made the certificate without its private key.');
      const keyId = await api.graph.addCertificate(objectId, {
        der: cert.der,
        displayName: PAX_APP_NAME,
        startDateTime: cert.notBefore,
        endDateTime: cert.notAfter,
      });
      retireCurrent(pax);
      pax.credentialType = 'certificate';
      pax.certificateThumbprint = cert.thumbprint;
      pax.certificateExpires = cert.notAfter;
      pax.certificateKeyId = keyId;
      ctx.save();
      ui.ok(`Made a certificate for the task in your certificate store, and added its public key to the app (until ${day(cert.notAfter)})`);
      return true;
    } catch (err) {
      if (cert?.thumbprint) await removeCertificate(runPwsh, cert.thumbprint).catch(() => undefined);
      if (forbidden(err)) throw ownerNeeded(ctx);
      certFailed = /** @type {Error} */ (err);
      ui.warn(`Couldn't give the task a certificate (${certFailed.message}). It gets a client secret instead.`);
    }
  }

  /** @type {{ secretText: string, endDateTime: string, keyId: string }} */
  let made;
  try {
    made = await api.graph.addPassword(objectId, addMonths(ctx.now(), CERT_MONTHS), `${PAX_APP_NAME} task`);
  } catch (err) {
    if (forbidden(err)) throw ownerNeeded(ctx);
    throw err;
  }
  try {
    await protectSecret(runPwsh, secretPath(ctx.env), made.secretText);
  } catch (err) {
    await api.graph.removePassword(objectId, made.keyId).catch(() => undefined);
    throw new Error(`Couldn't keep the client secret protected on this PC: ${/** @type {Error} */ (err).message}`);
  }
  retireCurrent(pax);
  pax.credentialType = 'secret';
  pax.secretKeyId = made.keyId;
  pax.secretExpires = made.endDateTime;
  ctx.save();
  ui.ok(`Made a client secret for the task, protected with Windows for you on this PC (until ${day(made.endDateTime)})`);
  return true;
}

/** @param {Ctx} ctx */
function ownerNeeded(ctx) {
  const app = ctx.config.app;
  return new Error(
    `You can't add a certificate or secret to ${app.displayName ?? 'the app registration'} (${app.appId}). ` +
      'Ask an admin to make you one of its owners, then run the installer again.',
  );
}

/**
 * Takes replaced certificates and secrets off the app and out of the certificate store. Called
 * once the task's script signs in with the new one.
 * @param {Ctx} ctx
 */
export async function retireCredentials(ctx) {
  const { ui, config, api } = ctx;
  const pax = paxOf(ctx);
  const objectId = config.app.objectId;
  const keyIds = pax.retiredKeyIds ?? [];
  if (objectId && keyIds.length) {
    try {
      const certs = await api.graph.removeCertificates(objectId, keyIds);
      const secrets = new Set((await api.graph.listPasswords(objectId)).map((p) => p.keyId));
      for (const id of keyIds.filter((k) => secrets.has(k))) await api.graph.removePassword(objectId, id);
      const n = certs + keyIds.filter((k) => secrets.has(k)).length;
      if (n) ui.ok(`Took the replaced ${n === 1 ? 'key' : 'keys'} off the app`);
      delete pax.retiredKeyIds;
    } catch (err) {
      ui.warn(`Couldn't take the replaced keys off the app yet (${/** @type {Error} */ (err).message}). The next repair tries again.`);
    }
  }
  const runPwsh = runPwshOf(ctx);
  for (const thumbprint of pax.retiredThumbprints ?? []) {
    await removeCertificate(runPwsh, thumbprint).catch(() => undefined);
  }
  delete pax.retiredThumbprints;
  if (pax.credentialType !== 'secret') rmSync(secretPath(ctx.env), { force: true });
  ctx.save();
}

/**
 * Uninstall: the task's certificate and protected secret on this PC, and their keys on the app
 * when the app stays.
 * @param {Ctx} ctx
 * @param {{ keepApp: boolean }} o
 */
export async function removePaxCredentials(ctx, o) {
  const { ui, config } = ctx;
  const pax = paxOf(ctx);
  const objectId = config.app.objectId;
  if (o.keepApp && objectId) {
    retireCurrent(pax);
    await retireCredentials(ctx);
  } else {
    const runPwsh = runPwshOf(ctx);
    for (const thumbprint of [pax.certificateThumbprint, ...(pax.retiredThumbprints ?? [])]) {
      if (thumbprint) await removeCertificate(runPwsh, thumbprint).catch(() => undefined);
    }
    delete pax.certificateThumbprint;
    delete pax.retiredThumbprints;
  }
  rmSync(secretPath(ctx.env), { force: true });
  ctx.save();
  ui.ok('Removed the task\'s certificate and secret from this PC');
  if (o.keepApp && objectId) ui.note(`The app registration ${config.app.displayName ?? config.app.appId} stays. To set this up again: ${commandLine('install --target pax')}`);
}
