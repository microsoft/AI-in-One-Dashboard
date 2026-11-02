// @ts-check
/**
 * Turns the AI in One Fabric edition's Power BI template (.pbit) into a semantic model definition
 * for Fabric: the template's own model, with its source parameters filled in and its org data table
 * made to match what the Classic org ingester writes.
 */
import { readFileSync } from 'node:fs';
import { SETUP_DIR } from '../catalog.js';
import { readZipEntry } from './zip.js';

/** The Fabric edition's Power BI template, relative to the source folder. */
export const MODEL_TEMPLATE = `${SETUP_DIR}/AI-in-One Dashboard - Fabric.pbit`;

/** The template's parameters for the Lakehouse's SQL analytics endpoint and the Lakehouse name. */
export const SERVER_PARAMETER = 'Fabric SQL Endpoint';
export const DATABASE_PARAMETER = 'Lakehouse Database';
/**
 * The template's optional parameter for an Agent 365 export's SharePoint URL. The installer leaves
 * it blank, so the Agents 365 table is empty until someone sets it.
 */
export const AGENT365_PARAMETER = 'Agent 365 (highly recommended)';
/** The table that reads dbo.copilot_org_data. */
export const ORG_TABLE = 'Chat + Agent Org Data';

/**
 * `definition.pbism` for a model defined by model.bim.
 * See https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/semantic-model-definition
 */
export const PBISM = {
  $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json',
  version: '4.0',
  settings: {},
};

/**
 * @typedef {{ compatibilityLevel: number, model: { expressions?: { name: string, expression: string | string[], description?: string | string[] }[], tables: any[], annotations?: { name: string, value: string }[], [k: string]: any } }} ModelBim
 */

/**
 * A .pbit's DataModelSchema is usually UTF-16, with or without a byte-order mark.
 * @param {Buffer} raw
 */
export function decodeText(raw) {
  if (raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le');
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return raw.subarray(3).toString('utf8');
  if (raw.length > 1 && raw[0] !== 0 && raw[1] === 0) return raw.toString('utf16le');
  return raw.toString('utf8');
}

/**
 * Reads the model from a Power BI template.
 * @param {Buffer} pbit
 * @returns {ModelBim}
 */
export function readTemplateModel(pbit) {
  const schema = JSON.parse(decodeText(readZipEntry(pbit, 'DataModelSchema')));
  if (!schema?.model?.tables) throw new Error('The template has no data model.');
  return { compatibilityLevel: schema.compatibilityLevel, model: schema.model };
}

/** @param {string} file */
export const loadTemplateModel = (file) => readTemplateModel(readFileSync(file));

/**
 * Power Query text literal.
 * @param {string} value
 */
export const mString = (value) => `"${String(value).replace(/"/g, '""')}"`;

/** @param {string | string[]} expression */
const mText = (expression) => (Array.isArray(expression) ? expression.join('\n') : String(expression));

/**
 * Sets a Power Query parameter's value and keeps its `meta [...]` record.
 * @param {ModelBim['model']} model
 * @param {string} name
 * @param {string} value
 */
export function setMParameter(model, name, value) {
  const expr = model.expressions?.find((e) => e.name === name);
  if (!expr) throw new Error(`The model has no "${name}" parameter.`);
  const text = mText(expr.expression);
  const at = text.indexOf(' meta [');
  if (at < 0) throw new Error(`"${name}" is not a parameter.`);
  expr.expression = `${mString(value)}${text.slice(at)}`;
}

/**
 * @param {ModelBim['model']} model
 * @param {string} name
 */
export function mParameter(model, name) {
  const expr = model.expressions?.find((e) => e.name === name);
  if (!expr) return undefined;
  const m = /^"((?:[^"]|"")*)" meta \[/.exec(mText(expr.expression));
  return m ? m[1].replace(/""/g, '"') : undefined;
}

/**
 * @typedef {object} ModelSettings
 * @property {string} server  The Lakehouse's SQL analytics endpoint.
 * @property {string} database  The Lakehouse name.
 */

/**
 * The model to deploy. The template is never modified.
 * @param {ModelBim} template
 * @param {ModelSettings} settings
 * @returns {ModelBim}
 */
export function buildModel(template, settings) {
  const model = structuredClone(template.model);
  setMParameter(model, SERVER_PARAMETER, settings.server);
  setMParameter(model, DATABASE_PARAMETER, settings.database);
  ensureColumns(model, ORG_TABLE);
  return { compatibilityLevel: template.compatibilityLevel, model };
}

/** Starts the steps `ensureColumns` adds, so it never adds them twice. */
export const ENSURE_COLUMNS_MARKER = '// Set by the AI in One installer: the declared columns, whatever their case in the Lakehouse.';

/** The steps `ensureColumns` adds, which the query mustn't already have. */
const ENSURE_STEPS = ['Declared', 'Present', 'CaseFixes', 'Renamed', 'Missing', 'Completed'];

/** Power Query types for the model's data types. */
const M_TYPES = /** @type {Record<string, string>} */ ({
  string: 'type text',
  int64: 'Int64.Type',
  double: 'type number',
  decimal: 'Currency.Type',
  dateTime: 'type datetime',
  boolean: 'type logical',
});

/** @param {string | undefined} dataType */
export const mType = (dataType) => (dataType && Object.hasOwn(M_TYPES, dataType) ? M_TYPES[dataType] : 'type any');

/**
 * The query's result step, last in its `let ... in`.
 * @param {string} text
 */
const resultStep = (text) => /\r?\n([ \t]*)in\s+(#"(?:[^"]|"")*"|[A-Za-z_][\w.]*)\s*$/.exec(text);

/**
 * A table's M query with steps added after its result, so it returns every listed column: a column
 * whose name differs only in case is renamed, and one that's missing is added, empty, with its type.
 * Throws when the query isn't the `let ... in Step` shape it expects, rather than guess.
 * @param {string} text  The query.
 * @param {{ name: string, type: string }[]} columns  Source column names and their Power Query types.
 * @returns {string}  The query, unchanged when it already has the steps.
 */
export function ensureColumnsQuery(text, columns) {
  if (text.includes(ENSURE_COLUMNS_MARKER)) return text;
  const result = resultStep(text);
  if (!result) throw new Error('The query has changed shape: it doesn\'t end with "in" and a step name.');
  const body = text.slice(0, result.index);
  const lines = body.split(/\r?\n/);
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  const tail = last >= 0 ? lines[last] : '';
  if (!/^\s*let\b/.test(body) || last < 1 || tail.includes('//') || tail.trimEnd().endsWith(',')) {
    throw new Error('The query has changed shape: its last step can\'t be followed by more.');
  }
  for (const step of ENSURE_STEPS) {
    if (new RegExp(`^[ \\t]*(?:${step}|#"${step}")[ \\t]*=`, 'm').test(body)) throw new Error(`The query has changed shape: it already has a step called ${step}.`);
  }
  const indent = /^[ \t]*/.exec(tail)?.[0] || '    ';
  const declared = columns.map((c) => `{${mString(c.name)}, ${c.type}}`).join(', ');
  const steps = [
    ENSURE_COLUMNS_MARKER,
    `Declared = {${declared}},`,
    `Present = Table.ColumnNames(${result[2]}),`,
    'CaseFixes = List.RemoveNulls(List.Transform(Declared, (d) => if List.Contains(Present, d{0}) then null else List.First(List.Transform(List.Select(Present, (p) => Text.Lower(p) = Text.Lower(d{0})), (p) => {p, d{0}}), null))),',
    `Renamed = Table.RenameColumns(${result[2]}, CaseFixes),`,
    'Missing = List.Select(Declared, (d) => not List.Contains(Table.ColumnNames(Renamed), d{0})),',
    'Completed = List.Accumulate(Missing, Renamed, (t, d) => Table.AddColumn(t, d{0}, each null, d{1}))',
  ];
  lines[last] = `${tail.trimEnd()},`;
  const head = lines.slice(0, last + 1).join('\n');
  return `${head}\n${steps.map((s) => `${indent}${s}`).join('\n')}\n${result[1]}in\n${indent}Completed`;
}

/**
 * Makes a table return every data column the model declares for it, whatever the case of the
 * Lakehouse's column names. The Classic org ingester writes `displayName` and `country` and no
 * `Email`, while the template declares `DisplayName`, `Country` and `Email`, so without this the
 * model's refresh fails. Added columns are empty. Only for tables where an empty column is harmless.
 * @param {ModelBim['model']} model
 * @param {string} tableName
 */
export function ensureColumns(model, tableName) {
  const table = model.tables.find((t) => t.name === tableName);
  if (!table) throw new Error(`The model has no "${tableName}" table.`);
  const partitions = (table.partitions ?? []).filter((/** @type {any} */ p) => p.source?.type === 'm');
  if (partitions.length !== 1) throw new Error(`The "${tableName}" table has changed shape: it should have one Power Query partition.`);
  const columns = (table.columns ?? [])
    .filter((/** @type {any} */ c) => (c.type ?? 'data') === 'data')
    .map((/** @type {any} */ c) => ({ name: c.sourceColumn ?? c.name, type: mType(c.dataType) }));
  if (!columns.length) return;
  const source = partitions[0].source;
  let text;
  try {
    text = ensureColumnsQuery(mText(source.expression), columns);
  } catch (err) {
    throw new Error(`The "${tableName}" table: ${/** @type {Error} */ (err).message}`);
  }
  source.expression = Array.isArray(source.expression) ? text.split('\n') : text;
}

/**
 * The path Fabric uses to match the model's data source to a connection.
 * @param {string} server
 * @param {string} database
 */
export const datasourcePath = (server, database) => `${server};${database}`;
