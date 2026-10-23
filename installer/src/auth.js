// @ts-check
/**
 * One sign-in, tokens for every API the installer calls.
 */
import { AzureCliCredential, DeviceCodeCredential, InteractiveBrowserCredential } from '@azure/identity';

export const SCOPES = {
  graph: 'https://graph.microsoft.com/.default',
  fabric: 'https://api.fabric.microsoft.com/.default',
  arm: 'https://management.azure.com/.default',
  keyVault: 'https://vault.azure.net/.default',
  storage: 'https://storage.azure.com/.default',
  powerbi: 'https://analysis.windows.net/powerbi/api/.default',
};

/** The APIs in SCOPES, as people know them. */
export const API_NAMES = /** @type {Record<keyof typeof SCOPES, string>} */ ({
  graph: 'Microsoft Graph',
  fabric: 'Fabric',
  arm: 'Azure Resource Manager',
  keyVault: 'Key Vault',
  storage: 'OneLake',
  powerbi: 'Power BI',
});

/** Azure Cloud Shell's own sign-in, which the Azure CLI uses until you run az login, covers only some APIs. */
const MSI_AUDIENCE = /not a supported MSI token audience/i;
export const AZ_LOGIN = 'az login --use-device-code';

/**
 * Whether the Azure CLI couldn't get a token because it is on Cloud Shell's own sign-in.
 * @param {unknown} err
 */
export const isMsiAudienceError = (err) => MSI_AUDIENCE.test(String(/** @type {any} */ (err)?.message ?? err));

/** @param {string[]} apis */
export const msiAudienceMessage = (apis) => `The Azure CLI is on Cloud Shell's own sign-in, which can't get tokens for ${apis.join(', ')}. Run ${AZ_LOGIN} to sign the Azure CLI in as you, then run the installer again. Or leave out --use-az to sign in with a code.`;

/**
 * A named API, or the scope of another one.
 * @typedef {keyof typeof SCOPES | `https://${string}/.default`} Resource
 */

/**
 * @typedef {object} AuthOptions
 * @property {string} [tenantId]  Omit to use the account's home tenant.
 * @property {'browser' | 'device-code' | 'azure-cli'} [method]
 * @property {string} [clientId]  The public client app to sign in with. Omit to use the Azure Identity library's default.
 * @property {(message: string) => void} [print]
 */

/**
 * @param {AuthOptions} opts
 * @returns {import('@azure/identity').TokenCredential}
 */
export function createCredential(opts) {
  const tenantId = opts.tenantId || undefined;
  const app = opts.clientId ? { clientId: opts.clientId } : {};
  switch (opts.method ?? 'browser') {
    case 'azure-cli':
      return new AzureCliCredential({ tenantId });
    case 'device-code':
      return new DeviceCodeCredential({
        tenantId,
        ...app,
        userPromptCallback: (info) => (opts.print ?? console.log)(info.message),
      });
    default:
      return new InteractiveBrowserCredential({ tenantId, ...app });
  }
}

/** Errors that mean the network blipped, not that the sign-in or request is wrong. */
const NETWORK_ERROR = /getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang up|NameResolutionError|Failed to resolve '|ConnectionError|Connection aborted|Max retries exceeded|Read timed out|network is unreachable|fetch failed/i;

/**
 * Whether an error is a transient network or DNS failure worth trying again.
 * @param {unknown} err
 */
export function isTransientNetworkError(err) {
  /** @type {any} */
  let e = err;
  for (let depth = 0; e && depth < 4; depth++, e = e.cause) {
    if (NETWORK_ERROR.test(`${e.code ?? ''} ${e.message ?? (typeof e === 'string' ? e : '')}`)) return true;
  }
  return false;
}

/** How many times a token is tried when the network blips, and the first wait; each wait doubles. */
export const TOKEN_ATTEMPTS = 6;
export const TOKEN_RETRY_MS = 2_000;

/**
 * Caches a token per resource until five minutes before it expires. Tries again, with backoff,
 * when the network or DNS blips.
 * @param {import('@azure/identity').TokenCredential} credential
 * @param {{ sleep?: (ms: number) => Promise<void>, debug?: (msg: string) => void }} [opts]
 */
export function createTokenProvider(credential, opts = {}) {
  const sleep = opts.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  /** @type {Map<Resource, { token: string, expiresOn: number }>} */
  const cache = new Map();
  /**
   * @param {Resource} resource
   * @param {{ abortSignal?: AbortSignal }} [o]  abortSignal: stop waiting for a sign-in. A code sign-in stops; a browser sign-in doesn't, see abandonSignIn.
   */
  return async function getToken(resource, o = {}) {
    const hit = cache.get(resource);
    if (hit && hit.expiresOn - Date.now() > 5 * 60_000) return hit.token;
    const scope = resource in SCOPES ? SCOPES[/** @type {keyof typeof SCOPES} */ (resource)] : resource;
    for (let attempt = 1; ; attempt++) {
      o.abortSignal?.throwIfAborted();
      try {
        const t = await (o.abortSignal ? credential.getToken(scope, { abortSignal: o.abortSignal }) : credential.getToken(scope));
        if (!t) throw new Error(`Could not get a token for ${resource}.`);
        cache.set(resource, { token: t.token, expiresOn: t.expiresOnTimestamp });
        return t.token;
      } catch (err) {
        if (isMsiAudienceError(err)) {
          throw new Error(msiAudienceMessage([resource in API_NAMES ? API_NAMES[/** @type {keyof typeof SCOPES} */ (resource)] : scope.replace(/\/\.default$/, '')]), { cause: err });
        }
        if (attempt >= TOKEN_ATTEMPTS || o.abortSignal?.aborted || !isTransientNetworkError(err)) throw err;
        const wait = Math.min(TOKEN_RETRY_MS * 2 ** (attempt - 1), 30_000);
        opts.debug?.(`Network error getting a token for ${resource}; trying again in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
  };
}

/** Whether a sign-in was given up on while it waited for the browser. */
let abandoned = false;

/**
 * Notes that a sign-in was given up on. A browser sign-in can't be stopped: its listener on localhost
 * waits for the browser for ever, and would keep the installer running after it's done. exitWhenDone
 * then ends it.
 */
export function abandonSignIn() {
  abandoned = true;
}

/**
 * Sets the exit code. After a sign-in was given up on, it also exits, rather than waiting for that
 * sign-in's listener, which never closes. But first it waits until stdout and stderr have written all
 * their output, as Node does when it exits by itself: on Linux and macOS a pipe writes asynchronously,
 * and exiting sooner would lose the last lines.
 * @param {number} code
 */
export function exitWhenDone(code) {
  process.exitCode = code;
  if (!abandoned) return;
  // An empty write calls back once everything written before it has been written.
  let waiting = 2;
  const flushed = () => {
    if (--waiting === 0) process.exit(code);
  };
  process.stdout.write('', flushed);
  process.stderr.write('', flushed);
}

/**
 * Gets a token for each named API in turn, so a sign-in that can't reach some of them fails before
 * the installer changes anything. Cloud Shell's own sign-in fails this way.
 * @param {(resource: Resource) => Promise<string>} getToken  From createTokenProvider, which keeps the tokens.
 * @param {(keyof typeof SCOPES)[]} [apis]
 */
export async function checkTokens(getToken, apis = /** @type {(keyof typeof SCOPES)[]} */ (Object.keys(SCOPES))) {
  /** @type {string[]} */
  const missing = [];
  for (const api of apis) {
    try {
      await getToken(api);
    } catch (err) {
      if (!isMsiAudienceError(/** @type {any} */ (err)?.cause ?? err)) throw err;
      missing.push(API_NAMES[api]);
    }
  }
  if (missing.length) throw new Error(msiAudienceMessage(missing));
}

/**
 * Reads claims from a JWT without verifying it (we only need tid/oid/upn for display and routing).
 * @param {string} token
 * @returns {Record<string, any>}
 */
export function decodeJwt(token) {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}
