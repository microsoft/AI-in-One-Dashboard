// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { emptyConfig, REPORT_NAME } from '../src/config.js';
import { blockedSettings, planReview, reserveNames } from '../src/steps/plan.js';
import { deployReport, ensureReports, reportsOn, reportsSummary, reportsWanted, reportUrl } from '../src/steps/report.js';
import { PBIR_SCHEMA, pbir, readTemplateReport, reportDefinition, reportSignature } from '../src/transform/report.js';
import { fakeCtx, fakeFabric, fakeUi, httpError, realSources } from './fakes.js';

/** @param {any} item @param {string} path */
const part = (item, path) => item.content.parts.find((/** @type {any} */ p) => p.path === path);
/** @param {any} item @param {string} path */
const partJson = (item, path) => JSON.parse(Buffer.from(part(item, path).payload, 'base64').toString('utf8'));

/**
 * A zip with stored (uncompressed) entries, enough for the template reader.
 * @param {Record<string, string>} files
 */
function storedZip(files) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** @param {{ answers?: any[], config?: any }} [o] */
function setup(o = {}) {
  const fabric = fakeFabric();
  const ui = fakeUi({ answers: o.answers });
  const config = o.config ?? emptyConfig();
  config.semanticModel.enabled = true;
  const made = fakeCtx({ ui: ui.ui, fabric: fabric.api, config });
  const model = fabric.add('SemanticModel', 'AI in One', null);
  config.semanticModel.id = model.id;
  return { ...made, fabric, ui, model };
}

test("the template's report is PBIR, without Desktop's copy of the AppSource visuals", () => {
  const file = realSources().modelFile;
  assert.ok(file, 'the checkout has the Power BI template');
  const parts = readTemplateReport(readFileSync(file));
  const paths = parts.map((p) => p.path);
  assert.ok(paths.includes('definition/report.json'));
  assert.ok(paths.includes('definition/version.json'));
  assert.ok(paths.some((p) => p.startsWith('definition/pages/')));
  assert.ok(paths.every((p) => p.startsWith('definition/') || p.startsWith('StaticResources/')), paths.join(', '));
  assert.deepEqual(paths, [...paths].sort(), 'sorted, so the signature is stable');
  for (const p of parts.filter((x) => x.path.endsWith('.json'))) JSON.parse(p.data.toString('utf8'));
});

test('readTemplateReport keeps only the report definition and its static resources, in path order', () => {
  const parts = readTemplateReport(
    storedZip({
      'DataModelSchema': '{}',
      'Report/definition/version.json': '{}',
      'Report/CustomVisuals/visual/package.json': '{}',
      'Report/StaticResources/RegisteredResources/logo.png': 'png',
      'Report/definition/report.json': '{"a":1}',
      'Report/definition/pages/': '',
    }),
  );
  assert.deepEqual(
    parts.map((p) => p.path),
    ['StaticResources/RegisteredResources/logo.png', 'definition/report.json', 'definition/version.json'],
  );
  assert.equal(parts[1].data.toString('utf8'), '{"a":1}');
});

test('a template without a PBIR report is an error', () => {
  assert.throws(() => readTemplateReport(readFileSync(/** @type {string} */ (realSources().modelFile)).subarray(0, 0)), /zip|central directory|file/i);
  assert.throws(
    () => readTemplateReport(storedZip({ 'Report/Layout': '{}', 'DataModelSchema': '{}' })),
    /^Error: The template has no report in the PBIR format\. Save it from Power BI Desktop with "Store reports using enhanced metadata format \(PBIR\)" on\.$/,
  );
});

test('reportDefinition binds the report to the model by id, and the signature ignores the model', () => {
  const parts = readTemplateReport(readFileSync(/** @type {string} */ (realSources().modelFile)));
  const def = reportDefinition(parts, 'model-9');
  assert.equal(def.parts[0].path, 'definition.pbir');
  assert.deepEqual(JSON.parse(Buffer.from(def.parts[0].payload, 'base64').toString('utf8')), pbir('model-9'));
  assert.equal(pbir('x').$schema, PBIR_SCHEMA);
  assert.equal(pbir('x').datasetReference.byConnection.connectionString, 'semanticmodelid=x');
  assert.ok(def.parts.every((p) => p.payloadType === 'InlineBase64'));
  assert.equal(def.parts.length, parts.length + 1);

  const sig = reportSignature(parts);
  assert.match(sig, /^[0-9a-f]{32}$/);
  assert.equal(sig, reportSignature(parts.map((p) => ({ ...p }))));
  const changed = parts.map((p) => (p.path === 'definition/report.json' ? { ...p, data: Buffer.concat([p.data, Buffer.from(' ')]) } : p));
  assert.notEqual(reportSignature(changed), sig);
});

test('reportsWanted: the AI in One report always comes with the model, and never without it', () => {
  const t = setup();
  const wanted = reportsWanted(t.ctx);
  assert.equal(REPORT_NAME, 'AI in One');
  assert.deepEqual(wanted.map((w) => w.name), ['AI in One']);
  assert.equal(wanted[0].model, t.config.semanticModel);
  assert.equal(wanted[0].file, t.ctx.sources.modelFile);
  assert.equal(reportsOn(t.config), true);

  t.ctx.sources = { ...t.ctx.sources, modelFile: undefined };
  assert.deepEqual(reportsWanted(t.ctx), [], 'a checkout without the template publishes nothing');
  t.ctx.sources = realSources();
  t.config.semanticModel.enabled = false;
  assert.equal(reportsOn(t.config), false);
  assert.deepEqual(reportsWanted(t.ctx), []);
});

test('deployReport: publishes on the model, then leaves it alone', async () => {
  const t = setup();
  const [w] = reportsWanted(t.ctx);
  await deployReport(t.ctx, w);
  const item = t.fabric.items.find((i) => i.type === 'Report');
  assert.ok(item);
  assert.equal(item.displayName, 'AI in One');
  assert.equal(partJson(item, 'definition.pbir').datasetReference.byConnection.connectionString, `semanticmodelid=${t.model.id}`);
  assert.ok(part(item, 'definition/report.json'));
  const r = t.config.semanticModel.report;
  assert.equal(r?.id, item.id);
  assert.equal(r?.modelId, t.model.id);
  assert.ok(r?.signature);
  assert.equal(t.saves(), 3, "the name being created, Fabric's operation for it, then the report");
  assert.match(t.ui.text(), /Published the AI in One report, on AI in One/);

  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls, ['createReport AI in One']);
  assert.match(t.ui.text(), /The AI in One report is in place/);
  assert.equal(reportUrl('ws-1', 'r-1'), 'https://app.powerbi.com/groups/ws-1/reports/r-1');
});

test('deployReport: a same-name report that is not ours is left alone', async () => {
  const t = setup();
  const theirs = t.fabric.add('Report', 'AI in One', 'theirs');
  await deployReport(t.ctx, reportsWanted(t.ctx)[0]);
  assert.equal(theirs.content, 'theirs');
  assert.equal(t.config.semanticModel.report?.name, 'AI in One 2');
  assert.deepEqual(t.fabric.calls, ['createReport AI in One 2']);
  assert.match(t.ui.text(), /"AI in One" is already in the workspace and isn't from this install, so it's left as it is\. AI in One's is called "AI in One 2"\./);
});

test('deployReport: a new template asks before replacing edits; no keeps them', async () => {
  const t = setup({ answers: [false, true] });
  const [w] = reportsWanted(t.ctx);
  await deployReport(t.ctx, w);
  const r = /** @type {import('../src/config.js').ReportConfig} */ (t.config.semanticModel.report);
  const published = r.signature;

  r.signature = 'older';
  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls, ['createReport AI in One']);
  assert.equal(r.signature, 'older', 'still out of date, so the next update asks again');
  assert.match(t.ui.text(), /Save a copy/);
  assert.match(t.ui.asked.join('\n'), /There's a new version of the AI in One report\. Update it\? Changes made to it in Power BI are replaced\./);

  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls.slice(1), ['updateReport AI in One']);
  assert.equal(r.signature, published);
  assert.match(t.ui.text(), /Updated the AI in One report/);
});

test('deployReport: a redeployed model is picked up without asking; a deleted report is published again', async () => {
  const t = setup();
  const [w] = reportsWanted(t.ctx);
  await deployReport(t.ctx, w);
  const r = /** @type {import('../src/config.js').ReportConfig} */ (t.config.semanticModel.report);

  const model = t.fabric.add('SemanticModel', 'AI in One 2', null);
  t.config.semanticModel.id = model.id;
  await deployReport(t.ctx, w);
  assert.deepEqual(t.fabric.calls.slice(1), ['updateReport AI in One']);
  assert.equal(r.modelId, model.id);
  const item = t.fabric.items.find((i) => i.id === r.id);
  assert.equal(partJson(item, 'definition.pbir').datasetReference.byConnection.connectionString, `semanticmodelid=${model.id}`);
  assert.equal(t.ui.asked.length, 0);
  assert.match(t.ui.text(), /The AI in One report reads AI in One again/);

  t.fabric.items.splice(t.fabric.items.indexOf(/** @type {any} */ (item)), 1);
  await deployReport(t.ctx, w);
  assert.match(t.ui.text(), /The AI in One report was deleted\. Publishing it again\./);
  assert.deepEqual(t.fabric.calls.slice(2), ['createReport AI in One']);
  assert.notEqual(r.id, item?.id);
});

test('ensureReports: a failure is reported and the install carries on; the next run publishes it', async () => {
  const t = setup();
  t.fabric.failures.createReport = [httpError(400, 'The definition is not valid.')];
  assert.equal(await ensureReports(t.ctx), false);
  assert.deepEqual(t.fabric.calls, ['createReport AI in One']);
  assert.match(t.ui.text(), /The AI in One report wasn't published: .*not valid/);
  assert.match(t.ui.text(), /Fix the problem, then run ".*update"/);
  assert.equal(t.config.semanticModel.report?.id, undefined);

  assert.equal(await ensureReports(t.ctx), true);
  assert.deepEqual(t.fabric.calls.slice(1), ['createReport AI in One']);
  assert.ok(t.config.semanticModel.report?.id);
});

test('ensureReports: a model that is not deployed is skipped, which is not a failure', async () => {
  const t = setup();
  delete t.config.semanticModel.id;
  t.config.semanticModel.name = 'AI in One';
  assert.equal(await ensureReports(t.ctx), true);
  assert.deepEqual(t.fabric.calls, []);
  assert.match(t.ui.text(), /Skipped the AI in One report: AI in One isn't deployed\./);
});

test('reportsSummary: links the published report', async () => {
  const t = setup();
  reportsSummary(t.ctx);
  assert.doesNotMatch(t.ui.text(), /Report:/, 'nothing before it is published');
  await ensureReports(t.ctx);
  reportsSummary(t.ctx);
  const id = t.config.semanticModel.report?.id;
  assert.match(t.ui.text(), new RegExp(`Report: +AI in One .*https://app\\.powerbi\\.com/groups/ws-1/reports/${id}`));
});

test('plan: the report name is reserved and listed for review', async () => {
  const t = setup();
  t.fabric.add('Report', 'AI in One', null);
  await reserveNames(t.ctx);
  assert.equal(t.config.semanticModel.report?.name, 'AI in One 2');
  const review = planReview(t.ctx);
  assert.deepEqual(
    review.creates.filter((i) => i.kind === 'Report').map((i) => [i.name, i.isNew]),
    [['AI in One 2', true]],
  );
  assert.match(String(review.creates.find((i) => i.kind === 'Report')?.detail), /From the Power BI template, reading AI in One\./);
  assert.match(review.runsOn[0].what, /semantic model and report/);
});

test('blockedSettings: the Power BI SDK visuals setting matters only with the report', () => {
  const settings = { CustomVisualsTenant: { enabled: false } };
  assert.deepEqual(blockedSettings(settings), []);
  assert.deepEqual(blockedSettings(settings, { reports: true }).map((s) => s.name), ['CustomVisualsTenant']);
  assert.deepEqual(blockedSettings({ CustomVisualsTenant: { enabled: false, delegateToCapacity: true } }, { reports: true }), []);
});
