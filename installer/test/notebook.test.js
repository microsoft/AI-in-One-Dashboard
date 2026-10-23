// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ASSETS_DIR, NOTEBOOKS, NOTEBOOKS_DIR } from '../src/catalog.js';
import {
  cellText,
  DATA_CHECK_FILE,
  findAssignmentCell,
  INLINE_SECRET_NOTE,
  MARKER,
  prepareNotebook,
  pyString,
  secretExpression,
  serialiseNotebook,
  setAssignment,
  toSourceLines,
} from '../src/transform/notebook.js';

const here = dirname(fileURLToPath(import.meta.url));
/** @param {string} file @param {string} [dir]  Folder under the source folder. */
const load = (file, dir = NOTEBOOKS_DIR) => JSON.parse(readFileSync(join(here, '..', '..', dir, file), 'utf8'));
/** @param {import('../src/catalog.js').NotebookKey} key */
const info = (key) => /** @type {import('../src/catalog.js').NotebookInfo} */ (NOTEBOOKS.find((n) => n.key === key));
/** @param {import('../src/catalog.js').NotebookKey} key */
const source = (key) => load(info(key).file, info(key).dir);
/** @param {import('../src/transform/notebook.js').Notebook} nb */
const allText = (nb) => nb.cells.map(cellText).join('\n');

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = { vaultUri: 'https://kv-ai-in-one-test.vault.azure.net/', secretName: 'ai-in-one-client-secret' };
const LAKEHOUSE = { id: '99999999-0000-0000-0000-000000000001', name: 'CopilotAnalytics', workspaceId: '88888888-0000-0000-0000-000000000002' };

test('setAssignment keeps the comment column', () => {
  const src = "TENANT_ID     = '<your-tenant-guid>'                  # Entra -> Overview\nOTHER = 1\n";
  const out = setAssignment(src, 'TENANT_ID', pyString(TENANT));
  const line = out.split('\n')[0];
  assert.equal(line, `TENANT_ID     = '${TENANT}'  # Entra -> Overview`);
  assert.ok(out.endsWith('OTHER = 1\n'));
});

test('setAssignment pads to the original comment column when the value is shorter', () => {
  const out = setAssignment("MODE          = 'incremental'   # load mode\n", 'MODE', "'x'");
  assert.equal(out, "MODE          = 'x'             # load mode\n");
});

test('setAssignment ignores commented-out lines and replaces a comment when asked', () => {
  const src = "# CLIENT_SECRET = getSecret('a', 'b')\nCLIENT_SECRET = '<value>'  # old\n";
  const out = setAssignment(src, 'CLIENT_SECRET', 'secret()', { comment: 'new', before: 'import x' });
  assert.equal(out, "# CLIENT_SECRET = getSecret('a', 'b')\nimport x\nCLIENT_SECRET = secret()  # new\n");
});

test('setAssignment handles values without comments and fails loudly when missing', () => {
  assert.equal(setAssignment('BACKFILL_DAYS = 180\n', 'BACKFILL_DAYS', '30'), 'BACKFILL_DAYS = 30\n');
  assert.throws(() => setAssignment('X = 1', 'TENANT_ID', "'t'"), /Could not find "TENANT_ID = \.\.\." in the notebook's config cell\./);
});

test('pyString escapes quotes and backslashes', () => {
  assert.equal(pyString("a'b\\c"), "'a\\'b\\\\c'");
});

test('toSourceLines matches Jupyter line storage', () => {
  assert.deepEqual(toSourceLines('a\nb\n'), ['a\n', 'b\n']);
  assert.deepEqual(toSourceLines('a\nb'), ['a\n', 'b']);
  assert.deepEqual(toSourceLines(''), []);
});

test('secretExpression reads Key Vault at run time, or is the value itself with no vault', () => {
  assert.equal(secretExpression(SECRET), "notebookutils.credentials.getSecret('https://kv-ai-in-one-test.vault.azure.net/', 'ai-in-one-client-secret')");
  assert.equal(secretExpression({ value: "it's" }), "'it\\'s'");
  assert.equal(MARKER, 'Set by the AI in One installer');
});

test('the catalogue: the Classic Fabric edition\'s three loads, then the installer\'s data check and refresh notebooks', () => {
  assert.deepEqual(NOTEBOOKS.map((n) => [n.key, n.dir ?? NOTEBOOKS_DIR, n.file]), [
    ['auditIngester', NOTEBOOKS_DIR, 'Copilot_Audit_Log_Direct_Ingester.ipynb'],
    ['licensedUsers', NOTEBOOKS_DIR, 'Copilot_Licensed_Users_Direct_Ingester.ipynb'],
    ['dataCheck', ASSETS_DIR, 'AIO_Data_Check.ipynb'],
    ['orgData', NOTEBOOKS_DIR, 'Copilot_Org_Data_Direct_Ingester.ipynb'],
    ['refreshModel', ASSETS_DIR, 'AIO_Refresh_Model.ipynb'],
  ]);
  assert.equal(NOTEBOOKS_DIR, 'Classic Editions/3. Fabric/notebooks');
  assert.equal(ASSETS_DIR, 'installer/assets/notebooks');
  assert.deepEqual(NOTEBOOKS.filter((n) => n.credentials).map((n) => n.key), ['auditIngester', 'licensedUsers', 'orgData']);
  for (const n of NOTEBOOKS) assert.equal(n.displayName, n.file.replace(/\.ipynb$/, ''), n.key);
});

for (const nbInfo of NOTEBOOKS.filter((n) => n.credentials)) {
  test(`${nbInfo.file}: credentials come from Key Vault`, () => {
    const src = load(nbInfo.file, nbInfo.dir);
    const before = JSON.stringify(src);
    const nb = prepareNotebook(src, { tenantId: TENANT, clientId: CLIENT, secret: SECRET, lakehouse: LAKEHOUSE });
    assert.equal(JSON.stringify(src), before, 'source notebook must not change');

    const all = allText(nb);
    assert.match(all, new RegExp(`^TENANT_ID\\s*=\\s*'${TENANT}'`, 'm'));
    assert.match(all, new RegExp(`^CLIENT_ID\\s*=\\s*'${CLIENT}'`, 'm'));
    assert.match(
      all,
      /^import notebookutils\nCLIENT_SECRET\s*=\s*notebookutils\.credentials\.getSecret\('https:\/\/kv-ai-in-one-test\.vault\.azure\.net\/', 'ai-in-one-client-secret'\) {2}# Set by the AI in One installer: read from Azure Key Vault at run time$/m,
    );
    assert.doesNotMatch(all, /^CLIENT_SECRET\s*=\s*'/m, 'no literal secret left');
    assert.doesNotMatch(all, /^(TENANT_ID|CLIENT_ID)\s*=\s*'</m, 'no placeholder left');
    assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse, LAKEHOUSE.id);
    assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse_name, LAKEHOUSE.name);
    assert.equal(nb.metadata.dependencies.lakehouse.default_lakehouse_workspace_id, LAKEHOUSE.workspaceId);
    assert.deepEqual(nb.metadata.dependencies.lakehouse.known_lakehouses, [{ id: LAKEHOUSE.id }]);
  });

  test(`${nbInfo.file}: with no Key Vault, the secret is in the notebook, with a note saying who can read it`, () => {
    const nb = prepareNotebook(load(nbInfo.file, nbInfo.dir), { tenantId: TENANT, clientId: CLIENT, secret: { value: 'v4lue\'s' } });
    const all = allText(nb);
    const line = all.split('\n').find((l) => /^CLIENT_SECRET\s*=/.test(l));
    assert.match(line ?? '', /^CLIENT_SECRET\s*= 'v4lue\\'s' {2}# Set by the AI in One installer: no Key Vault, so the secret is here\. Anyone with a role in this workspace can read it\. Each install, repair or update replaces it$/);
    assert.ok(INLINE_SECRET_NOTE.startsWith(MARKER));
    assert.doesNotMatch(all, /^[^#\n]*getSecret\(/m, 'no code reads Key Vault');
    assert.doesNotMatch(all, /^import notebookutils\nCLIENT_SECRET/m, 'nothing to import for a literal');
  });
}

for (const nbInfo of NOTEBOOKS.filter((n) => n.parameters.length)) {
  test(`${nbInfo.file}: one cell is tagged parameters`, () => {
    const nb = prepareNotebook(load(nbInfo.file, nbInfo.dir), { parameters: nbInfo.parameters });
    const tagged = nb.cells.filter((cell) => cell.metadata?.tags?.includes('parameters'));
    assert.equal(tagged.length, 1);
    for (const p of nbInfo.parameters) assert.match(cellText(tagged[0]), new RegExp(`^${p}\\s*=`, 'm'));
  });
}

test('pipeline parameters: the audit load\'s mode and days, and the refresh\'s workspace, model and time limit', () => {
  assert.deepEqual(info('auditIngester').parameters, ['MODE', 'BACKFILL_DAYS']);
  assert.deepEqual(info('refreshModel').parameters, ['WORKSPACE_ID', 'SEMANTIC_MODEL_ID', 'TIMEOUT_MINUTES']);
  for (const key of /** @type {const} */ (['licensedUsers', 'orgData', 'dataCheck'])) assert.deepEqual(info(key).parameters, [], key);
});

test('a parameters tag moves to the cell that holds the parameters; parameters split across cells, or missing, are an error', () => {
  const nb = {
    metadata: {},
    cells: [
      { cell_type: 'code', metadata: { tags: ['parameters', 'keep'] }, source: 'OLD = 1\n' },
      { cell_type: 'code', metadata: {}, source: 'A = 1\nB = 2\n' },
      { cell_type: 'code', source: 'C = 3\n' },
    ],
  };
  const out = prepareNotebook(nb, { parameters: ['A', 'B'] });
  assert.deepEqual(out.cells.map((c) => c.metadata?.tags), [['keep'], ['parameters'], undefined]);
  assert.deepEqual(nb.cells[0].metadata?.tags, ['parameters', 'keep'], 'the source is untouched');
  assert.throws(() => prepareNotebook(nb, { parameters: ['A', 'C'] }), /Pipeline parameters must all live in one cell\./);
  assert.throws(() => prepareNotebook(nb, { parameters: ['A', 'D'] }), /Could not find all parameters \(A, D\)\./);
});

test('every notebook in the catalogue exists and parses', () => {
  for (const nbInfo of NOTEBOOKS) {
    const nb = load(nbInfo.file, nbInfo.dir);
    assert.ok(Array.isArray(nb.cells) && nb.cells.length > 0, nbInfo.file);
  }
});

test('notebooks without credentials have none to fill in', () => {
  for (const nbInfo of NOTEBOOKS.filter((n) => !n.credentials)) {
    assert.equal(findAssignmentCell(load(nbInfo.file, nbInfo.dir), 'CLIENT_SECRET'), -1, nbInfo.file);
  }
  assert.throws(() => prepareNotebook(source('dataCheck'), { tenantId: TENANT, clientId: CLIENT, secret: SECRET }), /This notebook has no TENANT_ID setting\./);
});

test('the refresh notebook gets its workspace and model as defaults, for a run by hand', () => {
  const nb = prepareNotebook(source('refreshModel'), {
    parameters: info('refreshModel').parameters,
    values: { WORKSPACE_ID: LAKEHOUSE.workspaceId, SEMANTIC_MODEL_ID: 'model-1' },
  });
  const all = allText(nb);
  assert.match(all, new RegExp(`^WORKSPACE_ID = '${LAKEHOUSE.workspaceId}' {2}# Fabric workspace that holds the semantic model$`, 'm'));
  assert.match(all, /^SEMANTIC_MODEL_ID = 'model-1' {2}# The AI in One semantic model$/m);
  assert.match(all, /^TIMEOUT_MINUTES = 120 /m, 'the pipeline sets the time limit');
  assert.throws(() => prepareNotebook(source('refreshModel'), { values: { NO_SUCH: 'x' } }), /Could not find "NO_SUCH = \.\.\." in the notebook\./);
});

test('expressions are written as they are, marked as the installer\'s', () => {
  const nb = prepareNotebook(source('refreshModel'), { expressions: { TIMEOUT_MINUTES: '240' } });
  assert.match(allText(nb), /^TIMEOUT_MINUTES = 240 {2}# Set by the AI in One installer$/m);
  assert.throws(() => prepareNotebook(source('refreshModel'), { expressions: { NO_SUCH: 'True' } }), /Could not find "NO_SUCH = \.\.\." in the notebook\./);
});

test('data check gets a summary cell that saves JSON to the Lakehouse', () => {
  assert.equal(DATA_CHECK_FILE, 'Files/aio_installer/data_check.json');
  const src = source('dataCheck');
  assert.equal(prepareNotebook(src, { lakehouse: LAKEHOUSE }).cells.length, src.cells.length, 'only when asked');
  const nb = prepareNotebook(src, { dataCheckSummary: true, lakehouse: LAKEHOUSE });
  assert.equal(nb.cells.length, src.cells.length + 1);
  const lastCell = nb.cells[nb.cells.length - 1];
  assert.equal(lastCell.cell_type, 'code');
  const last = cellText(lastCell);
  assert.ok(last.startsWith(`# ${MARKER}: save a short summary for the installer to read back.`));
  assert.ok(last.includes(`'/lakehouse/default/${DATA_CHECK_FILE}'`));
  assert.match(last, /notebookutils\.notebook\.exit\(_json\.dumps\(_summary\)\)/);
  assert.ok(last.includes("_summary['identity'] = globals().get('overlap_summary')"));
  assert.match(last, /_pick\(_df, DATE_NAMES, \['creationdate', 'activitydate'\]\)/);
  assert.match(last, /_pick\(_df, ORG_NAMES\)/);
  assert.ok(last.includes("_info['withDepartment']"));
  assert.doesNotMatch(last, /spark\.sql\(|\.write\.|saveAsTable/, 'it reads tables and writes one file, nothing else');
  // The names the summary uses come from the notebook's own cells.
  const earlier = src.cells.map(cellText).join('\n');
  for (const name of ['def _resolve', 'def _pick', 'DATE_NAMES =', 'ORG_NAMES =', 'resolved =', 'overlap_summary = None', 'overlap_summary = {']) assert.ok(earlier.includes(name), name);
  assert.match(earlier, /\{'licensed': LICENSED_TABLE, 'audit': AUDIT_TABLE, 'org': ORG_TABLE\}/, 'the summary\'s audit and org keys');
});

test('serialiseNotebook round-trips', () => {
  const nb = prepareNotebook(source('orgData'), { tenantId: TENANT, clientId: CLIENT, secret: SECRET });
  const text = serialiseNotebook(nb);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), nb);
});

test('credentials must be given together', () => {
  assert.throws(() => prepareNotebook(source('orgData'), { tenantId: TENANT }), /tenantId, clientId and secret must be set together\./);
  assert.throws(() => prepareNotebook(source('orgData'), { tenantId: TENANT, clientId: CLIENT }), /together/);
});

test('a patch must match exactly once, and its text goes in as it is', () => {
  const src = source('auditIngester');
  assert.throws(() => prepareNotebook(src, { patches: [{ find: 'no such text', replace: '' }] }), /found it 0 times/);
  assert.throws(() => prepareNotebook(src, { patches: [{ find: 'TENANT_ID', replace: '' }] }), /Expected "TENANT_ID" once in the notebook, found it \d+ times\. The installer's patch needs updating\./);
  const nb = prepareNotebook(src, { patches: [{ find: 'BACKFILL_DAYS = 180', replace: "BACKFILL_DAYS = 90  # '$&'" }] });
  assert.match(allText(nb), /^BACKFILL_DAYS = 90 {2}# '\$&'/m, 'no $& substitution');
});

test('the Classic notebooks are only ever changed through the installer\'s copy', () => {
  for (const nbInfo of NOTEBOOKS) {
    assert.equal(nbInfo.patches, undefined, `${nbInfo.key}: AI in One deploys the edition's notebooks as they are`);
    assert.equal(nbInfo.expressions, undefined, nbInfo.key);
    assert.equal(nbInfo.values, undefined, nbInfo.key);
  }
  const src = source('auditIngester');
  const all = src.cells.map(cellText).join('\n');
  assert.match(all, /^MODE {10}= 'incremental'/m, 'the template default the pipeline overrides');
  assert.match(all, /^BACKFILL_DAYS = 180 /m);
});
