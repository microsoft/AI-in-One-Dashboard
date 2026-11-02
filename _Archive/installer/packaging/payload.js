// @ts-check
/**
 * What goes into AIInOneInstaller.exe, kept apart from the build so it can be tested.
 * The payload unpacks to:
 *   node/node.exe            Node.js, which runs everything below
 *   f/installer/             the installer, with its own notebooks and its production dependencies
 *   f/installer/managed-cli/ the pinned managed apps CLI, which deploys the AI in One app
 *   f/<templates>            the Classic Fabric notebooks, pipeline and Power BI template it deploys,
 *                            and the Power BI template the PAX path deploys
 *   f/app/dist/              the AI in One app, built
 * `f` stands in for the repo root, which keeps paths short when unpacked under the user's profile.
 */
import { posix } from 'node:path';
import { NOTEBOOKS, NOTEBOOKS_DIR } from '../src/catalog.js';
import { DEFAULT_SOURCE_DIR, PIPELINE_TEMPLATE, findModelTemplate, findPaxModelTemplate } from '../src/sources.js';
import { MODEL_TEMPLATE } from '../src/transform/model.js';

export { EXE_NAME } from '../src/launch.js';
/** The source folder (the repo root) inside the payload. */
export const SOURCE_ROOT = 'f';
/**
 * Longest path allowed inside the payload. It unpacks to
 * `%LOCALAPPDATA%\AIInOne\<version>-<hash>\`, about 70 characters for a typical profile, so
 * the deepest dependencies end up past Windows' 260-character limit. The launcher and Node.js
 * both use extended-length paths, which don't have that limit; this catches a dependency tree
 * that suddenly nests much deeper.
 */
export const MAX_PAYLOAD_PATH = 200;
/**
 * Longest path allowed for a native binary. Windows loads DLLs and Node.js addons only from
 * paths under 260 characters, so these must fit even under a long user name.
 */
export const MAX_NATIVE_PATH = 120;
export { MIRROR_REGISTRY, PUBLIC_REGISTRY, publicRegistry } from './registry.js';

/**
 * The oldest Node.js the installer runs on: its dependencies need 22.13 or later on the 22.x line.
 * The exe ships the Node.js that builds it.
 */
export const MIN_NODE = /** @type {const} */ ([22, 13]);

/** @param {string} [version] */
export function nodeVersionOk(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** @param {string} p */
const slash = (p) => p.replaceAll('\\', '/');

/**
 * The files under the source folder that the Fabric path deploys, relative to it: every notebook,
 * the pipeline template and the Power BI template. Taken from the installer's own lists, so what
 * ships can't drift from what it deploys.
 * @returns {string[]}
 */
export function fabricSourceFiles() {
  return [
    PIPELINE_TEMPLATE,
    ...NOTEBOOKS.map((nb) => posix.join(nb.dir ?? NOTEBOOKS_DIR, nb.file)),
    findModelTemplate(DEFAULT_SOURCE_DIR) ?? MODEL_TEMPLATE,
  ].map(slash);
}

/**
 * The files under the source folder that `loadSources` reads, relative to it: the Fabric path's,
 * and the Power BI template the PAX path deploys. The app's build isn't in git, so build-exe.js
 * adds it.
 * @returns {string[]}
 */
export function sourceFiles() {
  const pax = findPaxModelTemplate(DEFAULT_SOURCE_DIR);
  return [...fabricSourceFiles(), ...(pax ? [slash(pax)] : [])];
}

/**
 * What install.ps1 checks out of the release's commit in Azure Cloud Shell: the installer and the
 * files the Fabric path deploys, rather than the whole repo. The PAX path needs Windows, for its
 * scheduled task, so Cloud Shell leaves out its template. Patterns for
 * `git sparse-checkout set --no-cone`, anchored at the repo root.
 * @returns {string[]}
 */
export function sourcePaths() {
  return ['/installer/', ...fabricSourceFiles().map((f) => `/${f}`)];
}

/**
 * Whether a tracked installer file ships, given its path relative to the installer folder. The
 * managed apps CLI's package files ship so build-exe.js can install the pinned CLI next to them.
 * @param {string} rel
 */
export function installerFile(rel) {
  return /^(bin|src|assets)\//.test(rel)
    || ['package.json', 'package-lock.json', 'README.md', 'managed-cli/package.json', 'managed-cli/package-lock.json'].includes(rel);
}

/**
 * Names the payload by version and content, so a new download unpacks afresh.
 * @param {string} version
 * @param {string} sha256  Hex digest of the payload zip.
 */
export function payloadId(version, sha256) {
  return `${version}-${sha256.slice(0, 10)}`;
}

/**
 * The `x.y.z.0` form Windows file versions take.
 * @param {string} version
 */
export function fileVersion(version) {
  const parts = version.split(/[.+-]/).slice(0, 3).map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (parts.length < 3 || parts.some((n) => !(n >= 0 && n <= 65534))) throw new Error(`Can't make a file version from "${version}".`);
  return `${parts.join('.')}.0`;
}

/**
 * The sign-in library the managed apps CLI uses carries native builds for every system it supports,
 * and loads only the one for the system it runs on. The payload runs on x64 Windows only.
 */
const OTHER_SYSTEMS = /(^|\/)node_modules\/@azure\/msal-node-runtime\/dist\/(linux|macos|windows\/(arm64|x86))\//i;

/**
 * Whether an installed package's file can be left out of the payload. Nothing reads source maps
 * when the installer runs, nor native builds for other systems, and they'd add to every download.
 * @param {string} rel  Relative to the payload root.
 */
export function prunable(rel) {
  return /(^|\/)node_modules\/.+\.map$/i.test(rel) || OTHER_SYSTEMS.test(rel);
}

/**
 * The payload paths too long to unpack and run safely.
 * @param {string[]} files  Relative to the payload root.
 * @param {{ max?: number, native?: number }} [limits]
 */
export function tooLong(files, { max = MAX_PAYLOAD_PATH, native = MAX_NATIVE_PATH } = {}) {
  return files.filter((f) => f.length > (/\.(node|dll|exe)$/i.test(f) ? native : max));
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * GUIDs in a developer's local settings, such as their workspace and model IDs.
 * @param {string[]} texts
 * @param {Iterable<string>} [allowed]  IDs that are fine to ship, such as those the repo already holds.
 */
export function localIds(texts, allowed = []) {
  const skip = new Set([...allowed].map((a) => a.toLowerCase()));
  /** @type {Set<string>} */
  const ids = new Set();
  for (const t of texts) for (const m of t.matchAll(GUID)) if (!skip.has(m[0].toLowerCase())) ids.add(m[0].toLowerCase());
  return ids;
}

/**
 * The local IDs that turn up in a shipped file.
 * @param {string} text
 * @param {Set<string>} ids
 */
export function leakedIds(text, ids) {
  return [...new Set([...text.matchAll(GUID)].map((m) => m[0].toLowerCase()))].filter((id) => ids.has(id));
}
