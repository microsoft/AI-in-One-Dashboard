// @ts-check
/** Loads the notebooks, the pipeline template and the Power BI template from an AI in One checkout. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTEBOOKS, NOTEBOOKS_DIR, SETUP_DIR } from './catalog.js';
import { MODEL_TEMPLATE } from './transform/model.js';

/** The source folder: the repo root when the installer runs from a checkout, `f` in the exe. */
export const DEFAULT_SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PIPELINE_TEMPLATE = join(SETUP_DIR, 'pipelines', 'CopilotAdoptionPipeline.DataPipeline', 'pipeline-content.json');

/**
 * The Fabric edition's Power BI template, relative to the source folder. Found by pattern, so a
 * re-dated or renamed template still deploys: the usual name first, then the last by name of the
 * setup folder's `*Fabric*.pbit` files, which is the newest when they carry a YYYY-MM-DD date.
 * @param {string} root  The source folder.
 * @returns {string | undefined}
 */
export function findModelTemplate(root) {
  if (existsSync(join(root, MODEL_TEMPLATE))) return MODEL_TEMPLATE;
  const dir = join(root, SETUP_DIR);
  if (!existsSync(dir)) return undefined;
  const hits = readdirSync(dir)
    .filter((f) => /fabric.*\.pbit$/i.test(f))
    .sort()
    .reverse();
  return hits.length ? `${SETUP_DIR}/${hits[0]}` : undefined;
}

/**
 * @typedef {object} Sources
 * @property {string} dir
 * @property {Record<import('./catalog.js').NotebookKey, import('./transform/notebook.js').Notebook>} notebooks
 * @property {any} pipeline
 * @property {string} [modelFile]  The Fabric edition's .pbit, read only when the semantic model is deployed.
 */

/**
 * @param {string} [dir]  The root of an AI-in-One-Dashboard checkout.
 * @returns {Sources}
 */
export function loadSources(dir = DEFAULT_SOURCE_DIR) {
  const root = resolve(dir);
  const pipelineFile = join(root, PIPELINE_TEMPLATE);
  if (!existsSync(pipelineFile)) {
    throw new Error(`No pipeline template at ${pipelineFile}. Point --source at the root of the AI-in-One-Dashboard repo.`);
  }
  /** @type {any} */
  const notebooks = {};
  for (const nb of NOTEBOOKS) {
    const file = join(root, nb.dir ?? NOTEBOOKS_DIR, nb.file);
    if (!existsSync(file)) throw new Error(`Missing notebook ${file}.`);
    notebooks[nb.key] = readJson(file);
  }
  const model = findModelTemplate(root);
  return {
    dir: root,
    notebooks,
    pipeline: readJson(pipelineFile),
    modelFile: model ? join(root, model) : undefined,
  };
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
}
