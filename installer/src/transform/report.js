// @ts-check
/**
 * Turns a Power BI template's report into a Fabric report definition bound to a deployed
 * semantic model. The templates save their reports in the PBIR format, which is what Fabric takes.
 * See https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/report-definition
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readZipEntries } from './zip.js';

/** Where a .pbit keeps its report. */
const REPORT_DIR = 'Report/';
/**
 * The template's folders that are parts of a report definition. Its CustomVisuals folder is
 * Desktop's copy of the AppSource visuals, which the service loads by name from `publicCustomVisuals`.
 */
const PART_DIRS = ['definition/', 'StaticResources/'];

export const PBIR_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json';

/**
 * `definition.pbir`: the report reads the semantic model `modelId` in the same workspace.
 * @param {string} modelId
 */
export const pbir = (modelId) => ({
  $schema: PBIR_SCHEMA,
  version: '4.0',
  datasetReference: { byConnection: { connectionString: `semanticmodelid=${modelId}` } },
});

/** @typedef {{ path: string, data: Buffer }[]} ReportParts */

/**
 * The report's files from a Power BI template, with paths as the report definition names them.
 * @param {Buffer} pbit
 * @returns {ReportParts}
 */
export function readTemplateReport(pbit) {
  /** @type {ReportParts} */
  const parts = [];
  for (const [name, data] of readZipEntries(pbit, REPORT_DIR)) {
    const path = name.slice(REPORT_DIR.length);
    if (PART_DIRS.some((dir) => path.startsWith(dir))) parts.push({ path, data });
  }
  if (!parts.some((p) => p.path === 'definition/report.json')) {
    throw new Error('The template has no report in the PBIR format. Save it from Power BI Desktop with "Store reports using enhanced metadata format (PBIR)" on.');
  }
  return parts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** @param {string} file */
export const loadTemplateReport = (file) => readTemplateReport(readFileSync(file));

/**
 * The definition to create or update the report with.
 * @param {ReportParts} parts
 * @param {string} modelId
 */
export function reportDefinition(parts, modelId) {
  return {
    parts: [
      { path: 'definition.pbir', payload: Buffer.from(JSON.stringify(pbir(modelId), null, 2), 'utf8').toString('base64'), payloadType: 'InlineBase64' },
      ...parts.map((p) => ({ path: p.path, payload: p.data.toString('base64'), payloadType: 'InlineBase64' })),
    ],
  };
}

/**
 * A hash of the report's files, so a re-run knows whether the template changed.
 * @param {ReportParts} parts
 */
export function reportSignature(parts) {
  const hash = createHash('sha256');
  for (const p of parts) {
    hash.update(`${p.path}\0${p.data.length}\0`);
    hash.update(p.data);
  }
  return hash.digest('hex').slice(0, 32);
}
