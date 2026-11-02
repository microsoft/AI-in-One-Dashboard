// @ts-check
/**
 * The AI in One report from the Power BI template, published to the workspace and bound to the
 * installer's semantic model, so nobody has to open Power BI Desktop.
 */
import { REPORT_NAME } from '../config.js';
import { commandLine } from '../launch.js';
import { loadTemplateReport, reportDefinition, reportSignature } from '../transform/report.js';
import { c } from '../ui.js';
import { createItem, modelKey } from './fabric.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../config.js').ModelConfig} ModelConfig */

/** @param {string} workspaceId @param {string} reportId */
export const reportUrl = (workspaceId, reportId) => `https://app.powerbi.com/groups/${workspaceId}/reports/${reportId}`;

/**
 * The report is published: it always is, with the semantic model.
 * @param {import('../config.js').InstallConfig} config
 */
export const reportsOn = (config) => !!config.semanticModel.enabled;

/**
 * @typedef {object} WantedReport
 * @property {ModelConfig} model  The model it reads, where its record is kept.
 * @property {string} file  The template.
 * @property {string} name  Its name in a new install.
 */

/**
 * The report to publish: AI in One's, from the template the model comes from.
 * @param {Ctx} ctx
 * @returns {WantedReport[]}
 */
export function reportsWanted(ctx) {
  const { config, sources } = ctx;
  if (!reportsOn(config) || !sources.modelFile) return [];
  return [{ model: config.semanticModel, file: sources.modelFile, name: REPORT_NAME }];
}

/**
 * Publishes a template's report on a model, or updates it when the template changed or the
 * model was deployed again. A changed template replaces edits made in Power BI, so it asks first.
 * @param {Ctx} ctx
 * @param {WantedReport} w
 */
export async function deployReport(ctx, w) {
  const { ui, api } = ctx;
  const m = w.model;
  const ws = /** @type {string} */ (ctx.config.fabric.workspaceId);
  if (!m.id) {
    ui.warn(`Skipped the ${w.name} report: ${m.name} isn't deployed.`);
    return;
  }
  const r = (m.report ??= { name: w.name });
  const parts = loadTemplateReport(w.file);
  const signature = reportSignature(parts);
  const items = await api.fabric.listItems(ws, 'Report');

  if (r.id && !items.some((i) => i.id === r.id)) {
    ui.warn(`The ${r.name} report was deleted. Publishing it again.`);
    delete r.id;
  }
  if (!r.id) {
    const definition = reportDefinition(parts, m.id);
    const made = await createItem(ctx, `Report:${modelKey(ctx.config, m)}`, 'Report', r.name, items, (name, ref) => api.fabric.createReport(ws, name, definition, ref));
    r.id = made.id;
    r.name = made.name;
    if (made.resumed) await api.fabric.updateReport(ws, made.id, definition);
    ui.ok(`Published the ${made.name} report, on ${m.name}`);
  } else if (r.signature !== signature) {
    const update = await ui.confirm(`There's a new version of the ${r.name} report. Update it? Changes made to it in Power BI are replaced.`, true);
    if (!update) {
      ui.note(`Left ${r.name} as it is. To keep your changes, use File > Save a copy in Power BI, then run "${commandLine('update')}" and update it.`);
      return;
    }
    await api.fabric.updateReport(ws, r.id, reportDefinition(parts, m.id));
    ui.ok(`Updated the ${r.name} report`);
  } else if (r.modelId !== m.id) {
    await api.fabric.updateReport(ws, r.id, reportDefinition(parts, m.id));
    ui.ok(`The ${r.name} report reads ${m.name} again`);
  } else {
    ui.ok(`The ${r.name} report is in place`);
  }
  Object.assign(r, { signature, modelId: m.id });
  ctx.save();
}

/**
 * Publishes or updates the report. The model and data don't depend on it, so a failure is
 * reported and the install carries on.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>} false when a report failed.
 */
export async function ensureReports(ctx) {
  let ok = true;
  for (const w of reportsWanted(ctx)) {
    try {
      await deployReport(ctx, w);
    } catch (err) {
      ok = false;
      ctx.ui.fail(`The ${w.model.report?.name ?? w.name} report wasn't published: ${/** @type {Error} */ (err).message}`);
      ctx.ui.info(`Fix the problem, then run "${commandLine('update')}".`);
    }
  }
  return ok;
}

/**
 * The published report, for the summary.
 * @param {Ctx} ctx
 */
export function reportsSummary(ctx) {
  const ws = /** @type {string} */ (ctx.config.fabric.workspaceId);
  for (const w of reportsWanted(ctx)) {
    const r = w.model.report;
    if (r?.id) ctx.ui.info(`Report:     ${r.name}  ${c.dim(reportUrl(ws, r.id))}`);
  }
}
