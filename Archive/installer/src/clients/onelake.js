// @ts-check
/** Reads small files in a Lakehouse through the OneLake (ADLS Gen2) endpoint. */
import { HttpError } from '../http.js';

export const ONELAKE_URL = 'https://onelake.dfs.fabric.microsoft.com';

/** @param {import('../http.js').HttpClient} http  A client whose base URL is ONELAKE_URL. */
export function oneLakeApi(http) {
  const headers = { 'x-ms-version': '2023-11-03' };
  const url = (/** @type {string} */ workspaceId, /** @type {string} */ lakehouseId, /** @type {string} */ path) =>
    `/${workspaceId}/${lakehouseId}/${path.split('/').map(encodeURIComponent).join('/')}`;
  return {
    /**
     * Returns the parsed JSON, or null when the file isn't there.
     * @param {string} workspaceId
     * @param {string} lakehouseId
     * @param {string} path  Relative to the Lakehouse root, e.g. Files/x.json.
     */
    async readJson(workspaceId, lakehouseId, path) {
      try {
        const data = await http.get(url(workspaceId, lakehouseId, path), { headers });
        return typeof data === 'string' ? JSON.parse(data) : data;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },
  };
}

/** @typedef {ReturnType<typeof oneLakeApi>} OneLakeApi */
