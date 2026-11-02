// @ts-check
/**
 * PAX, pinned. The installer downloads the one version it was tested with and refuses a file
 * whose SHA-256 doesn't match. A new version comes only with a new installer, so the scheduled
 * runs skip PAX's own version check.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paxDir } from './names.js';

export const RELEASE_FILE = fileURLToPath(new URL('../../assets/pax/pax-release.json', import.meta.url));

/**
 * @typedef {object} PaxRelease
 * @property {string} version
 * @property {string} tag
 * @property {string} file
 * @property {string} url
 * @property {string} sha256  Lower-case hex.
 * @property {number} size
 * @property {string} releaseUrl
 */

/**
 * @param {string} [file]
 * @returns {PaxRelease}
 */
export function loadRelease(file = RELEASE_FILE) {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const valid =
    /^\d+\.\d+\.\d+$/.test(r.version) &&
    /^[0-9a-f]{64}$/.test(r.sha256) &&
    /^[\w.-]+\.ps1$/.test(r.file) &&
    r.url === `https://github.com/microsoft/PAX/releases/download/${r.tag}/${r.file}` &&
    Number.isInteger(r.size);
  if (!valid) throw new Error(`${file} doesn't pin a PAX release.`);
  return r;
}

/** @param {Buffer} data */
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * PAX's script under %LOCALAPPDATA%\AIInOne\pax\<version>\, downloaded when it isn't there or has
 * changed.
 * @param {{ release?: PaxRelease, fetch?: typeof fetch, env?: NodeJS.ProcessEnv }} [o]
 * @returns {Promise<{ path: string, version: string, sha256: string, downloaded: boolean }>}
 */
export async function ensurePax(o = {}) {
  const release = o.release ?? loadRelease();
  const dir = paxDir(release.version, o.env);
  const path = join(dir, release.file);
  const found = { path, version: release.version, sha256: release.sha256 };
  if (existsSync(path) && sha256(readFileSync(path)) === release.sha256) return { ...found, downloaded: false };
  const get = o.fetch ?? fetch;
  const manual = `If this PC can't reach GitHub, download ${release.file} from ${release.releaseUrl}, save it as ${path} and run the installer again.`;
  /** @type {Response} */
  let res;
  try {
    res = await get(release.url, { redirect: 'follow' });
  } catch (err) {
    throw new Error(`Couldn't download PAX ${release.version}: ${/** @type {Error} */ (err).message}. ${manual}`);
  }
  if (!res.ok) throw new Error(`Couldn't download PAX ${release.version}: GitHub answered ${res.status}. ${manual}`);
  const data = Buffer.from(await res.arrayBuffer());
  const got = sha256(data);
  if (got !== release.sha256) {
    throw new Error(
      `The PAX file from ${release.url} isn't the one this installer was tested with (SHA-256 ${got}, expected ${release.sha256}), so it wasn't saved or run.`,
    );
  }
  mkdirSync(dir, { recursive: true });
  const partial = `${path}.download`;
  writeFileSync(partial, data);
  rmSync(path, { force: true });
  renameSync(partial, path);
  return { ...found, downloaded: true };
}
