/**
 * Whether a newer installer is out. The installer asks GitHub once when it starts; offline, behind a
 * proxy or when GitHub is slow, the check gives up quietly and the installer carries on.
 */

export const REPO = 'microsoft/AI-in-One-Dashboard';
export const TAG_PREFIX = 'installer-v';
/**
 * The repo's newest releases. The repo's latest release is usually the dashboard's, not the
 * installer's, so the check looks through the list for installer releases.
 */
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=50`;
/** The installer's releases, linked when a release's own page can't be used. */
export const RELEASES_PAGE = `https://github.com/${REPO}/releases?q=${TAG_PREFIX}&expanded=true`;
/** Set to 1 to skip the check, for example on a computer that can't reach GitHub. */
export const OPT_OUT = 'AI_IN_ONE_NO_UPDATE_CHECK';

/** @param {string} v @returns {number[] | null} */
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/**
 * The release's version when it's newer than `current`, otherwise null. Pre-release and
 * unparseable versions never count as newer.
 * @param {string} current
 * @param {string} tag  A release tag such as `installer-v0.5.1`.
 */
export function newerVersion(current, tag) {
  if (!String(tag ?? '').startsWith(TAG_PREFIX)) return null;
  const latest = parse(tag.slice(TAG_PREFIX.length));
  const have = parse(String(current ?? '').replace(/[-+].*$/, ''));
  if (!latest || !have) return null;
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== have[i]) return latest[i] > have[i] ? latest.join('.') : null;
  }
  return null;
}

/**
 * The newest published installer release that's newer than `version`. Drafts, pre-releases and the
 * dashboard's own releases don't count.
 * @typedef {{ version: string, url: string }} Update
 * @param {{ version: string, fetch?: typeof globalThis.fetch, timeoutMs?: number, env?: Record<string, string | undefined> }} o
 * @returns {Promise<Update | null>}  Never rejects.
 */
export async function checkForUpdate(o) {
  const env = o.env ?? process.env;
  if (env[OPT_OUT] === '1' || env[OPT_OUT] === 'true') return null;
  const fetchFn = o.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return null;
  try {
    const res = await fetchFn(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ai-in-one-installer/${o.version}` },
      signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    });
    if (!res.ok) return null;
    const body = /** @type {any} */ (await res.json());
    if (!Array.isArray(body)) return null;
    /** @type {Update | null} */
    let best = null;
    for (const release of body) {
      if (!release || release.draft || release.prerelease) continue;
      const version = newerVersion(best?.version ?? o.version, release.tag_name);
      if (!version) continue;
      const url = typeof release.html_url === 'string' && release.html_url.startsWith(`https://github.com/${REPO}/`) ? release.html_url : RELEASES_PAGE;
      best = { version, url };
    }
    return best;
  } catch {
    return null;
  }
}
