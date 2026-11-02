// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { notebooksFor } from '../src/catalog.js';
import { emptyConfig } from '../src/config.js';
import { modelDeployed, notebookSettings, pipelineSignature } from '../src/steps/fabric.js';
import { prepareNotebook } from '../src/transform/notebook.js';
import {
  AGENT365_PARAMETER,
  buildModel,
  DATABASE_PARAMETER,
  datasourcePath,
  decodeText,
  ENSURE_COLUMNS_MARKER,
  ensureColumns,
  ensureColumnsQuery,
  loadTemplateModel,
  MODEL_TEMPLATE,
  mParameter,
  mString,
  mType,
  ORG_TABLE,
  readTemplateModel,
  SERVER_PARAMETER,
  setMParameter,
} from '../src/transform/model.js';
import { listZip, readZipEntry } from '../src/transform/zip.js';
import { fakeCtx, realSources } from './fakes.js';

/**
 * A minimal zip with one stored and one deflated entry per file.
 * @param {Record<string, { data: Buffer, deflate?: boolean }>} files
 */
function makeZip(files) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const [name, { data, deflate }] of Object.entries(files)) {
    const body = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}

const MODEL_FILE = /** @type {string} */ (realSources().modelFile);
const template = loadTemplateModel(MODEL_FILE);
const settings = { server: 'abc.datawarehouse.fabric.microsoft.com', database: 'CopilotAnalytics' };

/** @param {string | string[]} expression */
const joined = (expression) => (Array.isArray(expression) ? expression.join('\n') : expression);
/** @param {any} model @param {string} name */
const tableSource = (model, name) => model.tables.find((/** @type {any} */ t) => t.name === name).partitions[0].source;
/** @param {any} model @param {string} name */
const expression = (model, name) => model.expressions?.find((/** @type {any} */ e) => e.name === name)?.expression;

/** The steps ensureColumnsQuery adds after a query whose result step is `step`, for these Declared entries. */
const addedSteps = (/** @type {string} */ step, /** @type {string} */ declared, indent = '    ') => [
  ENSURE_COLUMNS_MARKER,
  `Declared = {${declared}},`,
  `Present = Table.ColumnNames(${step}),`,
  'CaseFixes = List.RemoveNulls(List.Transform(Declared, (d) => if List.Contains(Present, d{0}) then null else List.First(List.Transform(List.Select(Present, (p) => Text.Lower(p) = Text.Lower(d{0})), (p) => {p, d{0}}), null))),',
  `Renamed = Table.RenameColumns(${step}, CaseFixes),`,
  'Missing = List.Select(Declared, (d) => not List.Contains(Table.ColumnNames(Renamed), d{0})),',
  'Completed = List.Accumulate(Missing, Renamed, (t, d) => Table.AddColumn(t, d{0}, each null, d{1}))',
].map((s) => indent + s);

const QUERY_LINES = ['let', '    Source = Sql.Database("s", "d"),', '    Target = Source{[Schema="dbo", Item="t"]}[Data]', 'in', '    Target'];
const QUERY = QUERY_LINES.join('\n');
const COLUMNS = [{ name: 'DisplayName', type: 'type text' }, { name: 'Seats', type: 'Int64.Type' }];

test('zip: stored and deflated entries read back; a missing entry or non-zip fails', () => {
  const text = Buffer.from('hello '.repeat(200));
  const zip = makeZip({ 'a.txt': { data: Buffer.from('plain') }, 'b/c.json': { data: text, deflate: true } });
  assert.deepEqual([...listZip(zip).keys()], ['a.txt', 'b/c.json']);
  assert.equal(readZipEntry(zip, 'a.txt').toString(), 'plain');
  assert.equal(readZipEntry(zip, 'b/c.json').toString(), text.toString());
  assert.throws(() => readZipEntry(zip, 'nope'), /has no nope/);
  assert.throws(() => listZip(Buffer.alloc(40)), /Not a zip file/);
});

test('decodeText handles UTF-16 and UTF-8, with or without a byte-order mark', () => {
  const s = '{"model":"é"}';
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])), s);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')])), s);
  assert.equal(decodeText(Buffer.from(s, 'utf16le')), s);
  assert.equal(decodeText(Buffer.from(s, 'utf8')), s);
});

test('readTemplateModel takes the model from DataModelSchema and drops its name', () => {
  const schema = { name: 'abc-123', compatibilityLevel: 1600, model: { tables: [{ name: 'T' }] } };
  const pbit = makeZip({ DataModelSchema: { data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(schema), 'utf16le')]), deflate: true } });
  const bim = readTemplateModel(pbit);
  assert.deepEqual(bim, { compatibilityLevel: 1600, model: { tables: [{ name: 'T' }] } });
  assert.throws(() => readTemplateModel(makeZip({ DataModelSchema: { data: Buffer.from('{"model":{}}') } })), /no data model/);
});

test('M parameters: quotes are escaped; a missing or non-parameter query fails', () => {
  assert.equal(mString('a "b"'), '"a ""b"""');
  const model = { tables: [], expressions: [{ name: 'P', expression: 'null meta [IsParameterQuery=true]' }, { name: 'Q', expression: 'let x = 1 in x' }] };
  setMParameter(model, 'P', 'say "hi"');
  assert.equal(mParameter(model, 'P'), 'say "hi"');
  assert.throws(() => setMParameter(model, 'Missing', 'x'), /no "Missing" parameter/);
  assert.throws(() => setMParameter(model, 'Q', 'x'), /not a parameter/);
  assert.equal(mParameter(model, 'Q'), undefined);
  assert.equal(mParameter(model, 'Missing'), undefined);
  assert.equal(datasourcePath('s.example', 'db'), 's.example;db');
});

test('mType: the model data types as Power Query types, anything else as type any', () => {
  assert.deepEqual(
    ['string', 'int64', 'double', 'decimal', 'dateTime', 'boolean'].map((t) => mType(t)),
    ['type text', 'Int64.Type', 'type number', 'Currency.Type', 'type datetime', 'type logical'],
  );
  for (const t of [undefined, '', 'binary', 'variant', 'String', 'datetime', 'toString', 'constructor', '__proto__']) assert.equal(mType(t), 'type any', String(t));
});

test('ensureColumnsQuery: steps after the result rename columns that differ only in case and add missing ones with their type', () => {
  const out = ensureColumnsQuery(QUERY, COLUMNS);
  assert.equal(out, [
    'let',
    '    Source = Sql.Database("s", "d"),',
    '    Target = Source{[Schema="dbo", Item="t"]}[Data],',
    ...addedSteps('Target', '{"DisplayName", type text}, {"Seats", Int64.Type}'),
    'in',
    '    Completed',
  ].join('\n'));
  assert.ok(out.endsWith('\nin\n    Completed'));
  assert.equal(ensureColumnsQuery(out, COLUMNS), out, 'a second call changes nothing');
  assert.equal(out.split(ENSURE_COLUMNS_MARKER).length - 1, 1);

  // Its own indentation, a quoted result step on the "in" line, and Windows line endings.
  const quoted = ensureColumnsQuery('let\r\n  Source = x,\r\n  #"Changed Type" = Source\r\nin #"Changed Type"\r\n', [{ name: 'Email', type: 'type text' }]);
  assert.equal(quoted, [
    'let',
    '  Source = x,',
    '  #"Changed Type" = Source,',
    ...addedSteps('#"Changed Type"', '{"Email", type text}', '  '),
    'in',
    '  Completed',
  ].join('\n'));
  assert.ok(ensureColumnsQuery('let\n    a = 1\nin\n    a', [{ name: 'Say "hi"', type: 'type text' }]).includes('Declared = {{"Say ""hi""", type text}},'), 'names are M text');
});

test('ensureColumnsQuery: a query of another shape is an error, not a guess', () => {
  const end = /^Error: The query has changed shape: it doesn't end with "in" and a step name\.$/;
  for (const q of ['let\n    a = 1\nin\n    a + 1', 'Sql.Database("s", "d")', 'let\n    a = 1\nin']) {
    assert.throws(() => ensureColumnsQuery(q, COLUMNS), end, q);
  }
  const last = /^Error: The query has changed shape: its last step can't be followed by more\.$/;
  for (const q of [
    'let\n    a = 1,\nin\n    a',
    'let\n    a = 1 // one\nin\n    a',
    '    a = 1\nin\n    a',
    'let a = 1\nin\n    a',
  ]) {
    assert.throws(() => ensureColumnsQuery(q, COLUMNS), last, q);
  }
  for (const step of ['Declared', 'Present', 'CaseFixes', 'Renamed', 'Missing', 'Completed']) {
    for (const name of [step, `#"${step}"`]) {
      const q = `let\n    ${name} = 1,\n    a = 2\nin\n    a`;
      assert.throws(() => ensureColumnsQuery(q, COLUMNS), new RegExp(`^Error: The query has changed shape: it already has a step called ${step}\\.$`), q);
    }
  }
  assert.doesNotThrow(() => ensureColumnsQuery('let\n    MissingRows = 1,\n    Declared2 = 2\nin\n    Declared2', COLUMNS), 'only those exact names clash');
});

test('ensureColumns: declares the data columns by source name, keeps the expression\'s form, and fails on a changed table', () => {
  const columns = [
    { name: 'Name', sourceColumn: 'name_src', dataType: 'string' },
    { name: 'Seats', dataType: 'int64' },
    { name: 'Share', type: 'calculated', dataType: 'double', expression: '1' },
    { name: 'When', type: 'data', sourceColumn: 'When', dataType: 'dateTime' },
    { name: 'RowNumber-1', type: 'rowNumber', dataType: 'int64' },
  ];
  const declared = [{ name: 'name_src', type: 'type text' }, { name: 'Seats', type: 'Int64.Type' }, { name: 'When', type: 'type datetime' }];
  /** @param {any} partitions @param {any[]} [cols] */
  const model = (partitions, cols = columns) => ({ tables: [{ name: 'T', columns: cols, partitions }] });

  const lines = model([{ name: 'T', source: { type: 'm', expression: [...QUERY_LINES] } }]);
  ensureColumns(lines, 'T');
  const source = tableSource(lines, 'T');
  assert.ok(Array.isArray(source.expression), 'lines stay lines');
  assert.equal(joined(source.expression), ensureColumnsQuery(QUERY, declared));
  assert.match(joined(source.expression), /^ {4}Declared = \{\{"name_src", type text\}, \{"Seats", Int64\.Type\}, \{"When", type datetime\}\},$/m, 'calculated and row number columns are left out');

  const text = model([{ name: 'T', source: { type: 'm', expression: QUERY } }]);
  ensureColumns(text, 'T');
  assert.equal(tableSource(text, 'T').expression, ensureColumnsQuery(QUERY, declared), 'text stays text');
  const again = structuredClone(text);
  ensureColumns(again, 'T');
  assert.deepEqual(again, text, 'a second call changes nothing');

  const calculatedOnly = model([{ name: 'T', source: { type: 'm', expression: 'not M at all' } }], [columns[2]]);
  ensureColumns(calculatedOnly, 'T');
  assert.equal(tableSource(calculatedOnly, 'T').expression, 'not M at all', 'no data columns, nothing to add');

  assert.throws(() => ensureColumns({ tables: [] }, 'T'), /^Error: The model has no "T" table\.$/);
  const onePartition = /^Error: The "T" table has changed shape: it should have one Power Query partition\.$/;
  const m = { name: 'p', source: { type: 'm', expression: QUERY } };
  for (const partitions of [undefined, [], [{ name: 'c', source: { type: 'calculated', expression: 'x' } }], [m, structuredClone(m)]]) {
    assert.throws(() => ensureColumns(model(partitions), 'T'), onePartition, JSON.stringify(partitions));
  }
  assert.throws(
    () => ensureColumns(model([{ name: 'T', source: { type: 'm', expression: 'let\n    a = 1,\nin\n    a' } }]), 'T'),
    /^Error: The "T" table: The query has changed shape: its last step can't be followed by more\.$/,
  );
});

test('the real template: its source parameters filled, Agent 365 left blank, the org table completed, the rest untouched', () => {
  assert.ok(MODEL_FILE.replace(/\\/g, '/').endsWith(MODEL_TEMPLATE));
  const before = JSON.stringify(template);
  const bim = buildModel(template, settings);
  assert.equal(JSON.stringify(template), before, 'the template object is not modified');
  assert.ok(!joined(tableSource(template.model, ORG_TABLE).expression).includes(ENSURE_COLUMNS_MARKER));

  assert.equal(mParameter(bim.model, SERVER_PARAMETER), settings.server);
  assert.equal(mParameter(bim.model, DATABASE_PARAMETER), settings.database);
  assert.match(String(expression(bim.model, SERVER_PARAMETER)), /^"abc\.datawarehouse\.fabric\.microsoft\.com" meta \[IsParameterQuery=true/);
  assert.deepEqual(expression(bim.model, AGENT365_PARAMETER), expression(template.model, AGENT365_PARAMETER));
  assert.equal(mParameter(bim.model, AGENT365_PARAMETER), undefined, 'blank: the Agents 365 table stays empty until someone sets it');
  assert.equal(/** @type {any} */ (bim).name, undefined);
  assert.equal(bim.compatibilityLevel, template.compatibilityLevel);
  assert.ok(bim.compatibilityLevel >= 1600);

  const org = tableSource(bim.model, ORG_TABLE);
  assert.ok(Array.isArray(org.expression), 'the org query stays a list of lines');
  const query = joined(org.expression);
  assert.equal(query.split(ENSURE_COLUMNS_MARKER).length - 1, 1, 'the steps are added once');
  assert.ok(query.endsWith('\nin\n    Completed'));
  const declared = /^ *Declared = \{(.*)\},$/m.exec(query)?.[1] ?? '';
  for (const name of ['DisplayName', 'Email', 'Country']) assert.ok(declared.includes(`{"${name}", type text}`), `${name} is declared`);
  const dataColumns = template.model.tables.find((t) => t.name === ORG_TABLE).columns.filter((/** @type {any} */ c) => (c.type ?? 'data') === 'data');
  assert.equal(declared.split('}, {').length, dataColumns.length, 'every data column of the table');

  const rebuilt = structuredClone(bim.model);
  ensureColumns(rebuilt, ORG_TABLE);
  assert.deepEqual(rebuilt, bim.model, 'running it again adds nothing');

  for (const table of bim.model.tables) {
    if (table.name !== ORG_TABLE) assert.deepEqual(table, template.model.tables.find((t) => t.name === table.name), table.name);
  }
  assert.deepEqual(bim.model.expressions?.map((e) => e.name), template.model.expressions?.map((e) => e.name));
});

test('the refresh notebook is deployed only with a connected model, with its IDs filled in', () => {
  const modules = { orgData: true };
  assert.ok(!notebooksFor(modules).some((nb) => nb.key === 'refreshModel'));
  const nb = notebooksFor(modules, { semanticModel: true }).find((n) => n.key === 'refreshModel');
  assert.ok(nb);

  const config = emptyConfig();
  Object.assign(config.semanticModel, { enabled: true, id: 'model-9' });
  assert.equal(modelDeployed(config), false, 'not connected yet');
  assert.equal(pipelineSignature(config), 'core,orgData');
  config.semanticModel.bound = true;
  assert.equal(modelDeployed(config), true);
  assert.equal(pipelineSignature(config), 'core,orgData;model=model-9', 'connecting the model changes the pipeline');

  const { ctx } = fakeCtx({ config });
  const text = JSON.stringify(prepareNotebook(realSources().notebooks.refreshModel, notebookSettings(ctx, nb)));
  assert.match(text, /WORKSPACE_ID = 'ws-1'/);
  assert.match(text, /SEMANTIC_MODEL_ID = 'model-9'/);
});

test('the refresh notebook syncs the SQL endpoints, then runs one full refresh: the model has no refresh policy', () => {
  const code = realSources().notebooks.refreshModel.cells.map((c) => [].concat(/** @type {any} */ (c.source)).join('')).join('\n');
  assert.match(code, /refreshMetadata/);
  assert.match(code, /\{'type': 'full', 'commitMode': 'transactional', 'retryCount': 1\}/);
  assert.ok(code.lastIndexOf('_sync_sql_endpoints()') < code.lastIndexOf('_wait(_start('), 'sync first');
  assert.doesNotMatch(code, /applyRefreshPolicy/);
  assert.match(code, /notebookutils\.credentials\.getToken\('pbi'\)/);
  assert.ok(template.model.tables.every((t) => !t.refreshPolicy), 'so every table reloads each time');
});
