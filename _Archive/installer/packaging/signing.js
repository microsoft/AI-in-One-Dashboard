// @ts-check
/**
 * What a published AIInOneInstaller.exe has to pass: its Authenticode signature, the SHA-256 file
 * next to it and the release notes. Shared by finish-exe.js, the installer-exe workflow and the
 * ESRP signing pipeline, so each checks the same way. Those run it without `npm ci`, so it imports
 * nothing outside Node.js, src/launch.js and script.js.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EXE_NAME } from '../src/launch.js';
import { SCRIPT_NAME, ZIP_NAME, scriptCommand } from './script.js';

export const PUBLISHER = 'Microsoft Corporation';

/**
 * An installer release's version: x.y.z, or x.y.z-rc.N for a release candidate. installer-exe
 * drafts a release candidate as a pre-release, which the update check skips.
 */
export const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;

/** @param {string} version */
export const isReleaseCandidate = (version) => /-rc\.\d+$/.test(version);

/** Where the install steps live, relative to the repo's main branch: the installer's user guide. */
export const INSTALL_DOCS = 'blob/main/installer/README.md';
export const WITHOUT_EXE_DOCS = `${INSTALL_DOCS}#without-the-exe`;
export const PWSH_DOCS = `${INSTALL_DOCS}#from-powershell`;
export const INSTALLED_NODE_DOCS = `${INSTALL_DOCS}#it-approved-nodejs`;

/** @param {string} file */
export const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * The line in AIInOneInstaller.exe.sha256, in the format `sha256sum -c` reads.
 * @param {string} hash
 * @param {string} [name]
 */
export const sha256Line = (hash, name = EXE_NAME) => `${hash.toLowerCase()}  ${name}\n`;

/**
 * The hash in a .sha256 file, or undefined if it holds none.
 * @param {string} text
 */
export function parseSha256(text) {
  const m = /^\s*([0-9a-f]{64})\b/i.exec(text);
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * @typedef {{ status: string, signer?: string | null, timestamper?: string | null }} Signature
 *   What PowerShell's Get-AuthenticodeSignature reports: Status, and the subjects of the signer
 *   and timestamp certificates.
 */

/**
 * The common name in a certificate subject such as `CN=Microsoft Corporation, O=..., C=US`.
 * @param {string | null | undefined} subject
 */
export function commonName(subject) {
  const m = /(?:^|,\s*)CN=("([^"]*)"|[^,]*)/i.exec(subject ?? '');
  return m ? (m[2] ?? m[1]).trim() : undefined;
}

/**
 * Whether a signature is good enough to publish: valid, from the publisher and timestamped, so it
 * stays valid after the certificate expires.
 * @param {Signature} sig
 * @param {{ publisher?: string }} [o]
 * @returns {{ signed: boolean, ok: boolean, problems: string[] }}
 */
export function checkSignature(sig, { publisher = PUBLISHER } = {}) {
  const signed = Boolean(sig.signer) && sig.status !== 'NotSigned';
  if (!signed) return { signed: false, ok: false, problems: ['it isn\'t signed'] };
  const problems = [];
  if (sig.status !== 'Valid') problems.push(`its signature is ${sig.status}, not Valid`);
  const signer = commonName(sig.signer);
  if (signer !== publisher) problems.push(`it's signed by ${signer ?? sig.signer}, not ${publisher}`);
  if (!sig.timestamper) problems.push('its signature has no timestamp');
  return { signed: true, ok: !problems.length, problems };
}

/**
 * The release notes for an installer release.
 * @param {{ repo: string, sha256: string, signed: boolean, publisher?: string, version?: string }} o
 *   `version` adds the PowerShell commands, which need install.ps1 and the zip on the release.
 */
export function releaseNotes({ repo, sha256, signed, publisher = PUBLISHER, version }) {
  const base = `https://github.com/${repo}`;
  const lines = [];
  if (version && isReleaseCandidate(version)) {
    lines.push(
      `**Release candidate.** This pre-release is for testing ${version.replace(/-rc\.\d+$/, '')} before it's released. The installer doesn't offer it as an update.`,
      '',
    );
  }
  if (version) {
    lines.push(
      '### Install from PowerShell',
      '',
      'Paste this into PowerShell. It needs no admin rights: it downloads this release\'s installer as a zip, checks its SHA-256 and opens the installer in your browser.',
      '',
      '```powershell',
      `${scriptCommand(repo, version)}`,
      '```',
      '',
      `To keep the files, download \`${SCRIPT_NAME}\` and \`${ZIP_NAME}\` from this release and, where your execution policy allows scripts, run \`.\\${SCRIPT_NAME} -ZipPath .\\${ZIP_NAME}\`. With a Node.js your IT team has approved, add \`-UseInstalledNode\`: ${base}/${INSTALLED_NODE_DOCS}. More: ${base}/${PWSH_DOCS}`,
      '',
      '### Or download the exe',
      '',
    );
  }
  lines.push(
    `Download **${EXE_NAME}** and open it. Steps: ${base}/${INSTALL_DOCS}`,
    '',
    '### Check the download',
    '',
    `SHA-256: \`${sha256.toLowerCase()}\``,
    '',
    'In PowerShell, in the folder you downloaded it to, run:',
    '',
    '```powershell',
    `(Get-FileHash .\\${EXE_NAME} -Algorithm SHA256).Hash`,
    '```',
    '',
    `It should match the hash above, which is also in \`${EXE_NAME}.sha256\`. PowerShell prints it in capitals; that doesn't matter. A match confirms the file is the one in this release, not who published it.`,
    '',
  );
  if (signed) {
    lines.push(
      `The exe is signed by ${publisher}. To check, right-click it and choose **Properties**, then **Digital Signatures**.`,
      '',
    );
  } else {
    lines.push(
      '### If your organisation blocks it',
      '',
      'This build isn\'t code-signed yet, so Edge and Windows SmartScreen may warn about it. If your organisation\'s policy blocks it, don\'t work around it.',
      `${version ? 'Use the PowerShell command above, ' : 'Use '}another route in ${base}/${INSTALL_DOCS}, such as Azure Cloud Shell or running the installer with Node.js (${base}/${WITHOUT_EXE_DOCS}), or ask your IT team.`,
      '',
    );
  }
  return lines.join('\n');
}
