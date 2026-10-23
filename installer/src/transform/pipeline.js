// @ts-check
/**
 * Builds the customer's pipeline from the Classic Fabric edition's template: real IDs in, run-time
 * parameters for the audit load mode, the loads in two lanes, and a last step that refreshes the
 * semantic model.
 */
import { NOTEBOOKS } from '../catalog.js';

export const AUDIT_ACTIVITY = 'Run_Audit_Log_Ingester';
export const LICENSED_ACTIVITY = 'Run_Licensed_Users_Ingester';
/** The template's If Condition around the org data load, switched by {@link ORG_PARAMETER}. */
export const ORG_BRANCH = 'Conditionally_Run_Org_Data';
export const ORG_ACTIVITY = 'Run_Org_Data_Ingester';
export const ORG_PARAMETER = 'EnableOrgDataPull';
export const REFRESH_ACTIVITY = 'Refresh_Semantic_Model';

/**
 * Pipeline parameters the installer adds. Their defaults are what the schedule runs;
 * the first run overrides them for the backfill.
 */
export const RUN_PARAMETERS = {
  AuditMode: { type: 'String', defaultValue: 'incremental' },
  BackfillDays: { type: 'Int', defaultValue: 30 },
};

/** Notebook parameters bound to the pipeline parameters above, per activity. */
const BINDINGS = {
  [AUDIT_ACTIVITY]: {
    MODE: { parameter: 'AuditMode', type: 'string' },
    BACKFILL_DAYS: { parameter: 'BackfillDays', type: 'int' },
  },
};

/** @typedef {'standard' | 'large'} TenantScale */

/**
 * @typedef {object} ScaleProfile
 * @property {Record<string, string>} timeouts  Activity timeouts that replace the template's.
 * @property {{ timeout: string, minutes: number }} refresh  The refresh step's timeout, and how long its notebook waits for the refresh.
 */

/**
 * How the loads are sized for the tenant. Standard keeps the template's timeouts. Large is for tens of
 * thousands of users: it gives the loads and the model refresh more time. The audit load's own
 * settings, such as its window size, stay as the notebook has them: its notes say to shrink the
 * windows only when one times out.
 * @type {Record<TenantScale, ScaleProfile>}
 */
export const SCALE_PROFILES = {
  standard: {
    timeouts: {},
    refresh: { timeout: '0.03:00:00', minutes: 170 },
  },
  large: {
    timeouts: {
      [AUDIT_ACTIVITY]: '0.06:00:00',
      [LICENSED_ACTIVITY]: '0.00:30:00',
      [ORG_ACTIVITY]: '0.01:00:00',
    },
    refresh: { timeout: '0.05:00:00', minutes: 290 },
  },
};

/** @param {TenantScale | undefined} scale */
export const scaleProfile = (scale) => SCALE_PROFILES[scale === 'large' ? 'large' : 'standard'];

/**
 * @typedef {object} PipelineSettings
 * @property {string} workspaceId
 * @property {TenantScale} [scale]  Sizes the timeouts. Standard when absent.
 * @property {Partial<Record<import('../catalog.js').NotebookKey, string>>} notebookIds
 * @property {import('../catalog.js').ModuleChoice} modules
 * @property {number} [backfillDays]  Default for BackfillDays.
 * @property {string} [semanticModelId]  Adds a last step that refreshes this model.
 */

/** Bump when the pipeline's layout changes, so re-running the installer updates a pipeline an older version built. */
export const PIPELINE_VERSION = 1;
/** What this version changed, for people whose pipeline an older version, or a manual setup, built. */
export const PIPELINE_CHANGE =
  'This version runs the loads in two lanes so a small capacity isn\'t overloaded, retries a load that fails, loads only new audit days on each scheduled run, and refreshes the semantic model at the end. Your data is kept.';

/** Notebooks with the same tag share one high-concurrency Spark session (letters, digits and underscores only). */
export const SESSION_TAG = 'ai_in_one';

/**
 * Lane 2: every load except the audit log, one after another while lane 1 loads the audit log. A trial
 * or small capacity can start only a few notebooks at once and turns the rest away.
 */
export const LANE_ORDER = [LICENSED_ACTIVITY, ORG_BRANCH];

/**
 * Chains the lane 2 steps that are present. Each waits for the one before it to finish, whether it
 * succeeded or failed.
 * @param {any[]} activities  Top-level activities.
 */
export function chainLanes(activities) {
  /** @type {{ activity: string, dependencyConditions: string[] } | undefined} */
  let after;
  for (const name of LANE_ORDER) {
    const activity = activities.find((a) => a.name === name);
    if (!activity) continue;
    activity.dependsOn = after ? [after] : [];
    after = { activity: name, dependencyConditions: ['Completed'] };
  }
}

/** Seconds between retries: long enough for a busy capacity to free up. */
export const RETRY_INTERVAL_SECONDS = 300;

/**
 * A load that runs for up to an hour or more retries twice; a shorter one three times.
 * @param {string | undefined} timeout  Activity timeout, as d.hh:mm:ss.
 */
export function retryPolicy(timeout) {
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(timeout ?? '');
  const long = !m || Number(m[1] ?? 0) > 0 || Number(m[2]) >= 1;
  return { retry: long ? 2 : 3, retryIntervalInSeconds: RETRY_INTERVAL_SECONDS };
}

/**
 * Applies `retryPolicy` to every notebook, including those inside If Condition branches.
 * @param {any[]} activities
 */
export function applyRetries(activities) {
  for (const a of notebookActivities(activities)) a.policy = { ...a.policy, ...retryPolicy(a.policy?.timeout) };
}

/**
 * Every notebook, including those in If Condition branches, joins one high-concurrency session.
 * Fabric starts a new session for the sixth notebook, or when the Lakehouse or Spark settings differ.
 * @param {any[]} activities
 */
export function applySessionTag(activities) {
  for (const a of notebookActivities(activities)) a.typeProperties = { ...a.typeProperties, sessionTag: SESSION_TAG };
}

/**
 * @param {any[]} activities
 * @returns {Generator<any>}
 */
function* notebookActivities(activities) {
  for (const a of activities) {
    if (a.type === 'TridentNotebook') yield a;
    yield* notebookActivities([...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])]);
  }
}

/**
 * Runs the refresh notebook once the audit log has loaded and lane 2 has had its turn, so the model
 * never reads a half-loaded Lakehouse. A lane 2 load that failed leaves its table as it was, and the
 * refresh still runs.
 * @param {any[]} activities  Top-level activities.
 * @param {PipelineSettings} settings
 */
function refreshActivity(activities, settings) {
  const notebookId = settings.notebookIds.refreshModel;
  if (!notebookId) throw new Error('The semantic model refresh notebook has not been deployed.');
  const lastInLane = [...LANE_ORDER].reverse().find((name) => activities.some((a) => a.name === name));
  const { refresh } = scaleProfile(settings.scale);
  return {
    name: REFRESH_ACTIVITY,
    description: 'Refreshes the AI in One semantic model once the audit log has loaded and the licence and org data loads have finished.',
    type: 'TridentNotebook',
    dependsOn: [
      { activity: AUDIT_ACTIVITY, dependencyConditions: ['Succeeded'] },
      ...(lastInLane ? [{ activity: lastInLane, dependencyConditions: ['Completed'] }] : []),
    ],
    policy: { timeout: refresh.timeout, retry: 0, retryIntervalInSeconds: 60, secureOutput: false, secureInput: false },
    typeProperties: {
      notebookId,
      workspaceId: settings.workspaceId,
      parameters: {
        WORKSPACE_ID: { value: settings.workspaceId, type: 'string' },
        SEMANTIC_MODEL_ID: { value: /** @type {string} */ (settings.semanticModelId), type: 'string' },
        TIMEOUT_MINUTES: { value: refresh.minutes, type: 'int' },
      },
    },
  };
}

/**
 * @param {any} template  Parsed `pipeline-content.json`.
 * @param {PipelineSettings} settings
 */
export function buildPipeline(template, settings) {
  const doc = structuredClone(template);
  const props = doc.properties;
  if (!props || !Array.isArray(props.activities)) throw new Error('Pipeline template has no activities.');
  if (!props.parameters?.[ORG_PARAMETER]) throw new Error(`Pipeline template is missing the ${ORG_PARAMETER} parameter.`);
  // Org data is always collected: the model's org table reads it.
  props.parameters[ORG_PARAMETER].defaultValue = true;

  props.parameters = { ...props.parameters, ...structuredClone(RUN_PARAMETERS) };
  if (settings.backfillDays) props.parameters.BackfillDays.defaultValue = settings.backfillDays;

  for (const [activityName, params] of Object.entries(BINDINGS)) {
    const activity = findActivity(props.activities, activityName);
    if (!activity) throw new Error(`Pipeline template is missing ${activityName}.`);
    activity.typeProperties.parameters = activity.typeProperties.parameters ?? {};
    for (const [notebookParam, { parameter, type }] of Object.entries(params)) {
      activity.typeProperties.parameters[notebookParam] = {
        value: { value: `@pipeline().parameters.${parameter}`, type: 'Expression' },
        type,
      };
    }
  }
  applyScale(props.activities, scaleProfile(settings.scale));

  /** @type {Record<string, string>} */
  const ids = { REPLACE_WITH_WORKSPACE_ID: settings.workspaceId };
  for (const nb of NOTEBOOKS) {
    const id = settings.notebookIds[nb.key];
    if (nb.placeholder && id) ids[nb.placeholder] = id;
  }
  const filled = replacePlaceholders(doc, ids);

  const left = [...JSON.stringify(filled).matchAll(/REPLACE_WITH_[A-Z0-9_]+/g)].map((m) => m[0]);
  if (left.length) throw new Error(`Pipeline still has placeholders: ${[...new Set(left)].join(', ')}`);

  applyRetries(filled.properties.activities);
  if (settings.semanticModelId) filled.properties.activities.push(refreshActivity(filled.properties.activities, settings));
  chainLanes(filled.properties.activities);
  applySessionTag(filled.properties.activities);

  filled.properties.description =
    'Created by the AI in One installer. The loads run in two lanes rather than all at once, so a trial or small capacity isn\'t overloaded. ' +
    'Every notebook shares one Spark session (high concurrency for pipelines must be on in the workspace\'s Spark settings). ' +
    `Lane 1 loads the audit log${settings.semanticModelId ? ', then refreshes the semantic model' : ''}. ` +
    'Lane 2 loads licences, then org data; a load that fails doesn\'t stop the next' +
    `${settings.semanticModelId ? ' or the model refresh, so check each load\'s outcome in the run, or with the installer\'s status command' : ''}. ` +
    `Each load retries up to 3 times, ${RETRY_INTERVAL_SECONDS / 60} minutes apart. ` +
    'Scheduled runs use the parameter defaults: an incremental audit load, which re-reads from the start of the latest day loaded and replaces the table from there. ' +
    'The first run overrides them with AuditMode=backfill. ' +
    'Re-run the installer with "update" to pick up new notebook and pipeline versions.';
  return filled;
}

/**
 * Lengthens the timeouts the profile names. Runs before `applyRetries`, which reads the timeouts.
 * @param {any[]} activities
 * @param {ScaleProfile} profile
 */
function applyScale(activities, profile) {
  for (const [name, timeout] of Object.entries(profile.timeouts)) {
    const activity = findActivity(activities, name);
    if (!activity) throw new Error(`Pipeline template is missing ${name}.`);
    activity.policy = { ...activity.policy, timeout };
  }
}

/**
 * Depth-first search, including activities nested in If Condition branches.
 * @param {any[]} activities
 * @param {string} name
 * @returns {any}
 */
export function findActivity(activities, name) {
  for (const a of activities) {
    if (a.name === name) return a;
    const nested = [...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])];
    const hit = nested.length ? findActivity(nested, name) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

/**
 * @param {any} value
 * @param {Record<string, string>} ids
 * @returns {any}
 */
function replacePlaceholders(value, ids) {
  if (typeof value === 'string') return Object.prototype.hasOwnProperty.call(ids, value) ? ids[value] : value;
  if (Array.isArray(value)) return value.map((v) => replacePlaceholders(v, ids));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replacePlaceholders(v, ids)]));
  }
  return value;
}

/**
 * Parameters for the first run: a backfill that rebuilds the audit table.
 * @param {number} days
 */
export function firstRunParameters(days) {
  return { AuditMode: 'backfill', BackfillDays: days };
}
