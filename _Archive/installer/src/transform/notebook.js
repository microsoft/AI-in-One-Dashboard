// @ts-check
/**
 * Prepares a repo notebook for a customer's workspace, without touching the
 * source file: fills in the tenant and app IDs, reads the client secret from
 * Key Vault, tags the parameters cell and binds the default Lakehouse.
 */

/**
 * @typedef {{ cell_type: string, source: string | string[], metadata?: Record<string, any>, [k: string]: any }} Cell
 * @typedef {{ cells: Cell[], metadata: Record<string, any>, nbformat?: number, nbformat_minor?: number }} Notebook
 *
 * @typedef {object} NotebookSettings
 * @property {string} [tenantId]
 * @property {string} [clientId]
 * @property {{ vaultUri: string, secretName: string } | { value: string }} [secret]  Read from Key Vault at run time, or (with no Key Vault) the value itself.
 * @property {string[]} [parameters]  Assignments the pipeline overrides.
 * @property {Record<string, string>} [values]  Defaults to write into the notebook, e.g. IDs for a manual run.
 * @property {Record<string, string>} [expressions]  Python expressions to assign as they are, e.g. `True`.
 * @property {{ id: string, name: string, workspaceId: string }} [lakehouse]
 * @property {boolean} [dataCheckSummary]  Append a cell that returns a JSON summary to the installer.
 * @property {import('../catalog.js').NotebookPatch[]} [patches]  Text changes to code cells.
 */

export const MARKER = 'Set by the AI in One installer';

/** @param {Cell} cell */
export function cellText(cell) {
  return Array.isArray(cell.source) ? cell.source.join('') : cell.source ?? '';
}

/**
 * Stores text the way Jupyter does: one string per line, each ending in "\n" except the last.
 * @param {string} text
 * @returns {string[]}
 */
export function toSourceLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line)).filter((l) => l !== '');
}

/** @param {string} name */
function assignmentPattern(name) {
  // NAME = <python string literal or bare value>   # optional trailing comment
  return new RegExp(
    `^(${name}[ \\t]*=[ \\t]*)('(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|[^#\\n]*?)(?:([ \\t]+)(#[^\\n]*))?[ \\t]*$`,
    'm',
  );
}

/**
 * Python string literal, single-quoted.
 * @param {string} value
 */
export function pyString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Replaces the first top-level `NAME = value` line in `text`.
 * Keeps the column alignment and, unless a new one is given, the trailing comment.
 * @param {string} text
 * @param {string} name
 * @param {string} expression  Python expression to assign.
 * @param {{ comment?: string, before?: string }} [opts]  `before` adds a line above the assignment.
 */
export function setAssignment(text, name, expression, opts = {}) {
  const re = assignmentPattern(name);
  const m = re.exec(text);
  if (!m) throw new Error(`Could not find "${name} = ..." in the notebook's config cell.`);
  const [, lhs, oldValue, gap = '', oldComment] = m;
  const comment = opts.comment !== undefined ? `# ${opts.comment}` : oldComment;
  let line = `${lhs}${expression}`;
  if (comment) {
    const commentColumn = lhs.length + oldValue.length + gap.length;
    const pad = oldComment && opts.comment === undefined ? Math.max(2, commentColumn - line.length) : 2;
    line = `${line}${' '.repeat(pad)}${comment}`;
  }
  const replacement = opts.before ? `${opts.before}\n${line}` : line;
  return text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length);
}

/**
 * Index of the first code cell that assigns `name` at the top level.
 * @param {Notebook} nb
 * @param {string} name
 */
export function findAssignmentCell(nb, name) {
  const re = assignmentPattern(name);
  return nb.cells.findIndex((c) => c.cell_type === 'code' && re.test(cellText(c)));
}

/**
 * Python that reads the client secret from Key Vault at run time, or, when the install keeps
 * the secret in the notebook, the value as a string literal.
 * @param {{ vaultUri: string, secretName: string } | { value: string }} secret
 */
export function secretExpression(secret) {
  if ('value' in secret) return pyString(secret.value);
  return `notebookutils.credentials.getSecret(${pyString(secret.vaultUri)}, ${pyString(secret.secretName)})`;
}

/** The comment next to a client secret kept in the notebook. */
export const INLINE_SECRET_NOTE = `${MARKER}: no Key Vault, so the secret is here. Anyone with a role in this workspace can read it. Each install, repair or update replaces it`;

/** Where the data check's summary lands, relative to the Lakehouse root. */
export const DATA_CHECK_FILE = 'Files/aio_installer/data_check.json';

const DATA_CHECK_SUMMARY = `# ${MARKER}: save a short summary for the installer to read back.
# This is the only thing the installer's copy writes: one small JSON file under ${DATA_CHECK_FILE}.
import json as _json
import os as _os
from datetime import datetime as _dt, timezone as _tz
from pyspark.sql import functions as _F

_summary = {'checkedAt': _dt.now(_tz.utc).isoformat(timespec='seconds'), 'tables': {}}
for _key, _table in resolved.items():
    if not _table:
        _summary['tables'][_key] = None
        continue
    _df = spark.read.table(_table)
    _info = {'table': _table, 'rows': _df.count()}
    if _key == 'audit' and _info['rows']:
        _col = _pick(_df, DATE_NAMES, ['creationdate', 'activitydate'])
        if _col:
            _r = _df.select(_F.min(_col).alias('lo'), _F.max(_col).alias('hi')).collect()[0]
            _info['from'], _info['to'] = str(_r['lo']), str(_r['hi'])
    # How many people in the org data have a department, so thin by-department views can be explained.
    if _key == 'org' and _info['rows']:
        _col = _pick(_df, ORG_NAMES)
        if _col:
            _info['withDepartment'] = _df.filter(_F.length(_F.trim(_F.col(_col))) > 0).count()
    _summary['tables'][_key] = _info
# How many licensed users match Copilot activity, from the notebook's overlap check.
_summary['identity'] = globals().get('overlap_summary')

_path = '/lakehouse/default/${DATA_CHECK_FILE}'
_os.makedirs(_os.path.dirname(_path), exist_ok=True)
with open(_path, 'w') as _fh:
    _fh.write(_json.dumps(_summary))
print(_json.dumps(_summary, indent=2))
notebookutils.notebook.exit(_json.dumps(_summary))
`;

/**
 * Returns a prepared copy of `source`. The input is never modified.
 * @param {Notebook} source
 * @param {NotebookSettings} settings
 * @returns {Notebook}
 */
export function prepareNotebook(source, settings) {
  /** @type {Notebook} */
  const nb = structuredClone(source);

  const credentialFields = [settings.tenantId, settings.clientId, settings.secret].filter((v) => v !== undefined);
  if (credentialFields.length > 0) {
    if (credentialFields.length !== 3) throw new Error('tenantId, clientId and secret must be set together.');
    const idx = findAssignmentCell(nb, 'TENANT_ID');
    if (idx < 0) throw new Error('This notebook has no TENANT_ID setting.');
    const clientIdx = findAssignmentCell(nb, 'CLIENT_ID');
    const secretIdx = findAssignmentCell(nb, 'CLIENT_SECRET');
    if (clientIdx < 0 || secretIdx < 0) throw new Error('This notebook has no CLIENT_ID / CLIENT_SECRET setting.');

    updateCell(nb.cells[idx], (t) => setAssignment(t, 'TENANT_ID', pyString(/** @type {string} */ (settings.tenantId))));
    updateCell(nb.cells[clientIdx], (t) => setAssignment(t, 'CLIENT_ID', pyString(/** @type {string} */ (settings.clientId))));
    const secret = /** @type {{ vaultUri: string, secretName: string } | { value: string }} */ (settings.secret);
    updateCell(nb.cells[secretIdx], (t) =>
      'value' in secret
        ? setAssignment(t, 'CLIENT_SECRET', secretExpression(secret), { comment: INLINE_SECRET_NOTE })
        : setAssignment(t, 'CLIENT_SECRET', secretExpression(secret), {
            comment: `${MARKER}: read from Azure Key Vault at run time`,
            before: 'import notebookutils',
          }),
    );
  }

  if (settings.parameters?.length) {
    const cells = new Set(settings.parameters.map((p) => findAssignmentCell(nb, p)));
    if (cells.has(-1)) throw new Error(`Could not find all parameters (${settings.parameters.join(', ')}).`);
    if (cells.size !== 1) throw new Error('Pipeline parameters must all live in one cell.');
    const [idx] = cells;
    for (const c of nb.cells) {
      if (c.metadata?.tags) c.metadata.tags = c.metadata.tags.filter((/** @type {string} */ t) => t !== 'parameters');
    }
    const cell = nb.cells[idx];
    cell.metadata = cell.metadata ?? {};
    cell.metadata.tags = [...(cell.metadata.tags ?? []), 'parameters'];
  }

  for (const [name, value] of Object.entries(settings.values ?? {})) {
    const idx = findAssignmentCell(nb, name);
    if (idx < 0) throw new Error(`Could not find "${name} = ..." in the notebook.`);
    updateCell(nb.cells[idx], (t) => setAssignment(t, name, pyString(value)));
  }

  for (const [name, expression] of Object.entries(settings.expressions ?? {})) {
    const idx = findAssignmentCell(nb, name);
    if (idx < 0) throw new Error(`Could not find "${name} = ..." in the notebook.`);
    updateCell(nb.cells[idx], (t) => setAssignment(t, name, expression, { comment: MARKER }));
  }

  for (const patch of settings.patches ?? []) {
    const hits = nb.cells.filter((c) => c.cell_type === 'code' && cellText(c).includes(patch.find));
    const count = hits.reduce((n, c) => n + cellText(c).split(patch.find).length - 1, 0);
    if (count !== 1) throw new Error(`Expected "${patch.find.trim()}" once in the notebook, found it ${count} times. The installer's patch needs updating.`);
    updateCell(hits[0], (t) => t.replace(patch.find, () => patch.replace));
  }

  if (settings.lakehouse) {
    const { id, name, workspaceId } = settings.lakehouse;
    nb.metadata = nb.metadata ?? {};
    nb.metadata.dependencies = {
      ...(nb.metadata.dependencies ?? {}),
      lakehouse: {
        default_lakehouse: id,
        default_lakehouse_name: name,
        default_lakehouse_workspace_id: workspaceId,
        known_lakehouses: [{ id }],
      },
    };
  }

  if (settings.dataCheckSummary) {
    nb.cells.push({ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: toSourceLines(DATA_CHECK_SUMMARY) });
  }

  return nb;
}

/**
 * @param {Cell} cell
 * @param {(text: string) => string} fn
 */
function updateCell(cell, fn) {
  cell.source = toSourceLines(fn(cellText(cell)));
}

/**
 * Bytes for the item definition. Fabric accepts ipynb as plain JSON.
 * @param {Notebook} nb
 */
export function serialiseNotebook(nb) {
  return `${JSON.stringify(nb, null, 1)}\n`;
}
