// @ts-check
/**
 * install.ps1, the PowerShell launcher published next to AIInOneInstaller.exe. It downloads the
 * exe's payload as a zip, checks its SHA-256 and runs the installer with the Node.js inside, for
 * organisations that block downloaded exes. In Azure Cloud Shell, for tenants where no PC can run
 * it, it checks out just the installer and the files it deploys from the release's commit on GitHub
 * instead and runs the installer in the terminal.
 * build-exe.js fills in the template in launcher/install.ps1 for each release.
 */

export const ZIP_NAME = 'AIInOneInstaller.zip';
export const SCRIPT_NAME = 'install.ps1';

/**
 * Where a release's zip downloads from.
 * @param {string} repo  owner/name
 * @param {string} version
 */
export const zipUrl = (repo, version) => `https://github.com/${repo}/releases/download/installer-v${version}/${ZIP_NAME}`;

/**
 * The PowerShell command that runs a release's install.ps1. It names the version: the repo's Latest
 * release is the dashboard's, not the installer's.
 * @param {string} repo
 * @param {string} version
 */
export const scriptCommand = (repo, version) => `irm https://github.com/${repo}/releases/download/installer-v${version}/${SCRIPT_NAME} | iex`;

/**
 * Whether a path can go to `git sparse-checkout set --no-cone` as it is: anchored at the repo root,
 * with nothing git reads as a wildcard or escape, and printable ASCII, so that it sits in a
 * single-quoted PowerShell string once its quotes are doubled.
 * @param {string} p
 */
function sparsePathOk(p) {
  return /^\/[\x20-\x7e]+$/.test(p) && !/[*?[\]\\"`]|\/\/| $|(^|\/)\.\.?(\/|$)/.test(p);
}

/**
 * Fills in the launcher template.
 * @param {string} template  launcher/install.ps1
 * @param {{ version: string, sha256: string, id: string, repo: string, sizeMb: number, commit: string, nodeVersion: string, sourcePaths: string[] }} v
 *   commit: the commit the release is built from, which Azure Cloud Shell checks out.
 *   nodeVersion: the Node.js Cloud Shell downloads when its own is too old.
 *   sourcePaths: the repo paths Cloud Shell checks out of that commit, such as `/installer/`.
 */
export function installScript(template, v) {
  if (!/^[0-9a-f]{64}$/i.test(v.sha256)) throw new Error(`"${v.sha256}" isn't a SHA-256.`);
  if (!/^[\w.+-]+$/.test(v.version) || !/^[\w.+-]+$/.test(v.id)) throw new Error('The version and payload ID can only hold letters, digits and . + - _.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(v.repo)) throw new Error(`"${v.repo}" isn't an owner/name.`);
  if (!/^[0-9a-f]{40}$/i.test(v.commit)) throw new Error(`"${v.commit}" isn't a full commit ID.`);
  if (!/^\d+\.\d+\.\d+$/.test(v.nodeVersion)) throw new Error(`"${v.nodeVersion}" isn't a Node.js version.`);
  if (!v.sourcePaths.length) throw new Error('Cloud Shell needs the paths to check out.');
  const bad = v.sourcePaths.find((p) => !sparsePathOk(p));
  if (bad !== undefined) throw new Error(`"${bad}" isn't a plain repo path starting with /.`);
  /** @type {Record<string, string>} */
  const values = {
    VERSION: v.version,
    SHA256: v.sha256.toLowerCase(),
    PAYLOAD_ID: v.id,
    ZIP_URL: zipUrl(v.repo, v.version),
    ZIP_NAME,
    SIZE_MB: String(Math.max(1, Math.round(v.sizeMb))),
    REPO: v.repo,
    COMMIT: v.commit.toLowerCase(),
    NODE_VERSION: v.nodeVersion,
    SOURCE_PATHS: v.sourcePaths.map((p) => `'${p.replaceAll("'", "''")}'`).join(', '),
  };
  const text = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => {
    if (!(k in values)) throw new Error(`install.ps1 has an unknown placeholder ${m}.`);
    return values[k];
  });
  // Windows PowerShell 5.1 reads a file without a BOM as the system code page, and iex gets whatever irm decoded.
  const odd = [...text].find((ch) => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && !'\r\n\t'.includes(ch)));
  if (odd) throw new Error(`install.ps1 must be plain ASCII; it holds U+${odd.charCodeAt(0).toString(16).padStart(4, '0')}.`);
  return text.replace(/\r?\n/g, '\r\n');
}

/**
 * The zip SHA-256 a generated install.ps1 checks for, or undefined.
 * @param {string} script
 */
export function scriptSha256(script) {
  const m = /^\s*\$Sha256 = '([0-9a-f]{64})'\s*$/m.exec(script);
  return m ? m[1] : undefined;
}
