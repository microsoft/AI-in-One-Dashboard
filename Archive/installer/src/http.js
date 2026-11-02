// @ts-check
/**
 * Small JSON-over-HTTPS client with bearer tokens, retries on throttling and
 * transient errors, and Fabric long-running-operation polling.
 */

export class HttpError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, method: string, url: string, code?: string, body?: any, headers?: Headers }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'HttpError';
    this.status = info.status;
    this.method = info.method;
    this.url = info.url;
    this.code = info.code;
    this.body = info.body;
    this.headers = info.headers;
  }
}

/**
 * @typedef {object} RequestOptions
 * @property {any} [body]  Sent as JSON unless it is a string or bytes.
 * @property {Record<string, string | number | boolean | undefined>} [query]
 * @property {Record<string, string>} [headers]
 * @property {number[]} [retryOn]  Extra statuses to retry (e.g. 403 while a role assignment propagates).
 * @property {(status: number, data: any) => boolean} [retryIf]  Finer control than retryOn, e.g. to skip "already exists".
 * @property {number} [maxRetries]
 * @property {boolean} [once]  Not safe to send twice (it creates something). Not retried after a network error or a
 *   status the server may have sent after acting on it; only 429, which it sends instead, and `retryOn`/`retryIf`.
 *   The caller works out what happened instead.
 * @property {number} [maxWaitMs]  Cap for the total time spent retrying `retryOn` statuses.
 * @property {boolean} [lroResult]  For a 202, fetch the operation's result when it succeeds (creates, getDefinition).
 * @property {(stateUrl: string) => void} [onAccepted]  For a 202, called with the operation's URL before it's followed, so a caller can record it.
 *
 * @typedef {{ status: number, headers: Headers, data: any }} HttpResponse
 *
 * @typedef {object} ClientOptions
 * @property {string} baseUrl
 * @property {() => Promise<string>} getToken
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {(msg: string) => void} [debug]
 */

export const defaultSleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Seconds from Retry-After, or exponential backoff with jitter.
 * @param {Headers | undefined} headers
 * @param {number} attempt  0-based.
 */
export function retryDelayMs(headers, attempt) {
  const ra = headers?.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs, 1), 120) * 1000;
    const when = Date.parse(ra);
    if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 1000), 120_000);
  }
  const base = Math.min(2 ** attempt * 1000, 30_000);
  return base + Math.floor(Math.random() * 500);
}

/** @param {any} body */
function errorDetails(body) {
  const e = body?.error ?? body;
  const code = e?.code ?? e?.errorCode ?? body?.errorCode;
  const message = e?.message ?? body?.message ?? (typeof body === 'string' ? body : undefined);
  return { code: typeof code === 'string' ? code : undefined, message: typeof message === 'string' ? message : undefined };
}

/** @param {ClientOptions} options */
export function createClient(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const debug = options.debug ?? (() => {});

  /**
   * @param {string} pathOrUrl
   * @param {RequestOptions['query']} [query]
   */
  function resolve(pathOrUrl, query) {
    const url = new URL(/^https?:\/\//.test(pathOrUrl) ? pathOrUrl : options.baseUrl.replace(/\/$/, '') + pathOrUrl);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    return url.toString();
  }

  /**
   * @param {string} method
   * @param {string} pathOrUrl
   * @param {RequestOptions} [opts]
   * @returns {Promise<HttpResponse>}
   */
  async function request(method, pathOrUrl, opts = {}) {
    const url = resolve(pathOrUrl, opts.query);
    const maxRetries = opts.maxRetries ?? 6;
    const retryOn = new Set(opts.retryOn ?? []);
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const token = await options.getToken();
      /** @type {Record<string, string>} */
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(opts.headers ?? {}) };
      /** @type {string | Uint8Array | undefined} */
      let body;
      if (opts.body !== undefined) {
        body = typeof opts.body === 'string' || opts.body instanceof Uint8Array ? opts.body : JSON.stringify(opts.body);
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      }
      debug(`${method} ${url}`);
      /** @type {Response} */
      let res;
      try {
        res = await fetchImpl(url, { method, headers, body: /** @type {BodyInit | undefined} */ (body) });
      } catch (err) {
        if (attempt < maxRetries && !opts.once) {
          await sleep(retryDelayMs(undefined, attempt));
          continue;
        }
        throw new Error(`${method} ${url} failed: ${/** @type {Error} */ (err).message}`);
      }
      const text = await res.text();
      /** @type {any} */
      let data = text;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          // keep text
        }
      } else {
        data = null;
      }
      if (res.ok) return { status: res.status, headers: res.headers, data };

      const elapsed = Date.now() - started;
      const withinWait = opts.maxWaitMs === undefined || elapsed < opts.maxWaitMs;
      const wanted = retryOn.has(res.status) || (opts.retryIf?.(res.status, data) ?? false);
      const transient = opts.once ? res.status === 429 : TRANSIENT.has(res.status);
      const canRetry = attempt < maxRetries && (transient || (wanted && withinWait));
      if (canRetry) {
        const delay = retryDelayMs(res.headers, attempt);
        debug(`  ${res.status}, retrying in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
        continue;
      }
      const { code, message } = errorDetails(data);
      throw new HttpError(`${method} ${new URL(url).pathname} returned ${res.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`, {
        status: res.status,
        method,
        url,
        code,
        body: data,
        headers: res.headers,
      });
    }
  }

  /** Where to ask how a Fabric long-running operation is going. @param {HttpResponse} accepted  The 202 response. */
  function operationUrl(accepted) {
    const location = accepted.headers.get('location');
    const operationId = accepted.headers.get('x-ms-operation-id');
    return location ?? (operationId ? resolve(`/operations/${operationId}`) : undefined);
  }

  /**
   * Follows a Fabric long-running operation to completion.
   * Returns the operation result for creates and getDefinition, or null when there is none.
   * @param {HttpResponse} accepted  The 202 response.
   * @param {{ timeoutMs?: number, result?: boolean }} [opts]  `result` fetches `/result` even without a Location header.
   */
  async function waitForOperation(accepted, opts = {}) {
    const stateUrl = operationUrl(accepted);
    if (!stateUrl) throw new Error('Fabric accepted the request but returned no operation to follow.');
    const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
    let delay = retryDelayMs(accepted.headers, 0);
    for (;;) {
      await sleep(delay);
      const res = await request('GET', stateUrl);
      const status = res.data?.status;
      if (status === 'Succeeded') {
        const resultUrl = res.headers.get('location') ?? (opts.result ? `${stateUrl.replace(/\/$/, '')}/result` : undefined);
        if (!resultUrl) return null;
        const result = await request('GET', resultUrl);
        return result.data;
      }
      if (status === 'Failed' || status === 'Undefined') {
        const { code, message } = errorDetails(res.data);
        throw new Error(`Fabric operation failed${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`);
      }
      if (Date.now() > deadline) throw new Error('Timed out waiting for a Fabric operation.');
      delay = retryDelayMs(res.headers, 1);
    }
  }

  /**
   * Request that may answer 202 with a long-running operation.
   * @param {string} method
   * @param {string} path
   * @param {RequestOptions} [opts]
   */
  async function requestLro(method, path, opts) {
    const res = await request(method, path, opts);
    if (res.status === 202) {
      const url = operationUrl(res);
      if (url) opts?.onAccepted?.(url);
      return waitForOperation(res, { result: opts?.lroResult });
    }
    return res.data;
  }

  /**
   * Walks `continuationUri` (Fabric) or `@odata.nextLink` (Graph) or `nextLink` (ARM).
   * @param {string} path
   * @param {RequestOptions} [opts]
   * @returns {Promise<any[]>}
   */
  async function list(path, opts) {
    /** @type {any[]} */
    const items = [];
    /** @type {string | undefined} */
    let next = path;
    let first = true;
    while (next) {
      const res = await request('GET', next, first ? opts : { headers: opts?.headers });
      first = false;
      items.push(...(res.data?.value ?? []));
      next = res.data?.continuationUri ?? res.data?.['@odata.nextLink'] ?? res.data?.nextLink ?? undefined;
    }
    return items;
  }

  return {
    request,
    requestLro,
    waitForOperation,
    list,
    /** @param {string} p @param {RequestOptions} [o] */
    get: async (p, o) => (await request('GET', p, o)).data,
    /** @param {string} p @param {any} body @param {RequestOptions} [o] */
    post: async (p, body, o) => (await request('POST', p, { ...o, body })).data,
    /** @param {string} p @param {any} body @param {RequestOptions} [o] */
    put: async (p, body, o) => (await request('PUT', p, { ...o, body })).data,
    /** @param {string} p @param {any} body @param {RequestOptions} [o] */
    patch: async (p, body, o) => (await request('PATCH', p, { ...o, body })).data,
    /** @param {string} p @param {RequestOptions} [o] */
    del: async (p, o) => (await request('DELETE', p, o)).data,
  };
}

/** @typedef {ReturnType<typeof createClient>} HttpClient */
