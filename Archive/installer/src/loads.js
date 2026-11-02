// @ts-check
/**
 * How each load in a pipeline run went, in plain words: one card per source, with why a load
 * failed and what to do about it. The pipeline has no load-status step, and a load that fails in
 * lane 2 doesn't stop the run, so a run can complete with a failed load: the cards come from the
 * activity runs.
 */
import { AUDIT_ACTIVITY, LICENSED_ACTIVITY, ORG_ACTIVITY, REFRESH_ACTIVITY } from './transform/pipeline.js';

/** Plain names for the pipeline's loads. */
export const LOAD_LABELS = /** @type {Record<string, string>} */ ({
  [AUDIT_ACTIVITY]: 'Copilot audit log',
  [LICENSED_ACTIVITY]: 'Licensed users',
  [ORG_ACTIVITY]: 'Org data',
  [REFRESH_ACTIVITY]: 'AI in One model refresh',
});

/** "Run_Org_Data_Ingester" reads "Org Data Ingester". @param {string} name */
export const loadLabel = (name) => LOAD_LABELS[name] ?? name.replace(/^Run_/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

/** Stands for the rerun command in fix texts; the terminal and the web page each fill it in. */
export const RERUN = '{rerun}';

/** Why a load failed, tested in order against "errorCode=<code> <message>", case-insensitively. */
export const REASONS = [
  {
    kind: 'capacity',
    pattern: 'TooManyRequestsForCapacity|(?:code|status)[\\s:\'"=-]{0,6}430\\b',
    text: 'Fabric\'s capacity was too busy to start it.',
    fix: `Nothing is lost. ${RERUN} once the capacity is quieter, such as outside working hours. If it keeps happening, ask your Fabric admin for a larger capacity.`,
  },
  {
    kind: 'notSynced',
    pattern: 'is not in (?:the )?database|SQL (?:analytics )?endpoint (?:to|has not|hasn.t) (?:sync|caught up)',
    text: 'The model refreshed before the Lakehouse\'s SQL endpoint had caught up with the new tables.',
    fix: `Nothing is lost. Wait a couple of minutes, then ${RERUN}.`,
  },
  {
    kind: 'signIn',
    pattern: 'AADSTS\\d+|\\b401\\b|\\b403\\b|Unauthori[sz]ed|Forbidden|invalid_client|consent|credential|sign.?in',
    text: 'It couldn\'t sign in, or wasn\'t allowed to read the data.',
    fix: `Check the app registration still has admin consent for its permissions and its client secret hasn't expired (if a vault admin adds it, that it's in the vault and you can read it), then ${RERUN}.`,
  },
  {
    kind: 'timeout',
    pattern: 'timed? ?out|timeout|exceeded the (?:maximum|allowed)',
    text: 'It ran out of time.',
    fix: `${RERUN}. If it keeps happening, choose "More than 10,000" for the tenant size with Repair or change, so the loads get longer time limits, or ask for a larger capacity.`,
  },
];

/** @typedef {'capacity' | 'notSynced' | 'signIn' | 'timeout' | 'other'} ReasonKind */

/**
 * @param {{ errorCode?: unknown, message?: unknown } | null | undefined} error
 * @returns {{ kind: ReasonKind, text: string, fix: string }}
 */
export function classifyFailure(error) {
  const subject = `errorCode=${error?.errorCode ?? ''} ${error?.message ?? ''}`;
  const hit = REASONS.find((r) => new RegExp(r.pattern, 'i').test(subject));
  if (hit) return { kind: /** @type {ReasonKind} */ (hit.kind), text: hit.text, fix: hit.fix };
  const first = String(error?.message ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return {
    kind: 'other',
    text: first ? `It stopped with an error: ${first.slice(0, 240)}` : 'It stopped without saying why.',
    fix: `Open the pipeline's latest run in Fabric to see the full error, then ${RERUN}.`,
  };
}

/**
 * @typedef {object} LoadCard
 * @property {string} activity
 * @property {string} name  Plain name of the source.
 * @property {'ok' | 'failed' | 'skipped' | 'running'} state
 * @property {string} [reason]
 * @property {ReasonKind} [kind]
 * @property {string[]} fix  What to do, with {@link RERUN} still in it.
 * @property {number} [attempts]
 * @property {boolean} [counted]  Failed, which leaves an install partly set up. Every failed load counts.
 */

const RUN_STATES = /** @type {Record<string, LoadCard['state']>} */ ({
  Succeeded: 'ok',
  Failed: 'failed',
  Cancelled: 'failed',
  TimedOut: 'failed',
  InProgress: 'running',
  Queued: 'running',
  Skipped: 'skipped',
});

/** @param {any} a */
const branches = (a) => [...(a.typeProperties?.ifTrueActivities ?? []), ...(a.typeProperties?.ifFalseActivities ?? [])];

/**
 * Whether one dependency held, given its activity's status.
 * @param {string | undefined} status  Succeeded, Failed or Skipped; anything else counts as Skipped.
 * @param {string[]} conditions
 */
export function conditionMet(status, conditions) {
  const s = status === 'Succeeded' || status === 'Failed' ? status : status === 'Cancelled' || status === 'TimedOut' ? 'Failed' : 'Skipped';
  return conditions.some((c) => c === s || (c === 'Completed' && s !== 'Skipped'));
}

/**
 * One card per source in a run. A source switched off (its IfCondition chose the empty branch) gets
 * no card.
 * @param {Map<string, any> | null} runs  The last attempt of each activity, by name.
 * @param {any[]} [activities]  Top-level activities of the pipeline definition, so loads that never
 *   started show as skipped with the steps they were waiting for. Without it, only the runs show.
 * @returns {LoadCard[]}
 */
export function loadCards(runs, activities) {
  if (!runs) return [];
  /** @param {string} name */
  const statusOf = (name) => runs.get(name)?.status ?? 'Skipped';

  /** @type {{ load: any, parent?: any }[]} */
  const loads = [];
  if (activities) {
    for (const a of activities) {
      if (a.type === 'IfCondition') for (const inner of branches(a)) loads.push({ load: inner, parent: a });
      else loads.push({ load: a });
    }
  } else {
    for (const r of runs.values()) if (r.activityType !== 'IfCondition') loads.push({ load: { name: r.activityName, type: r.activityType } });
  }

  /** @type {LoadCard[]} */
  const cards = [];
  for (const { load, parent } of loads) {
    const name = load.name;
    const run = runs.get(name);
    if (!run && parent && runs.get(parent.name)?.status === 'Succeeded') continue;
    const state = RUN_STATES[run?.status ?? 'Skipped'] ?? 'running';
    /** @type {LoadCard} */
    const card = { activity: name, name: loadLabel(name), state, fix: [] };
    if (run?.attempts > 1) card.attempts = run.attempts;
    if (state === 'failed') {
      const why = classifyFailure(run?.error);
      card.reason = why.text;
      card.kind = why.kind;
      card.fix = [why.fix];
    } else if (state === 'skipped') {
      const waiting = ((parent ?? load).dependsOn ?? [])
        .filter((/** @type {any} */ d) => !conditionMet(statusOf(d.activity), d.dependencyConditions ?? ['Succeeded']))
        .map((/** @type {any} */ d) => loadLabel(innerName(activities, d.activity)));
      card.reason = waiting.length ? `It didn't run, because it waits for: ${[...new Set(waiting)].join(', ')}.` : 'It didn\'t run.';
      card.fix = [`It runs again once those succeed: ${RERUN}.`];
    }
    cards.push(card);
  }
  return cards;
}

/**
 * The load inside an IfCondition, so a dependency on the condition reads as the source it runs.
 * @param {any[] | undefined} activities
 * @param {string} name
 */
function innerName(activities, name) {
  const a = activities?.find((x) => x.name === name);
  const inner = a?.type === 'IfCondition' ? branches(a)[0] : undefined;
  return inner?.name ?? name;
}

/**
 * Puts the rerun instruction into a fix text, capitalised at the start of a sentence.
 * @param {string} text
 * @param {string} phrase  e.g. `run "AIInOneInstaller.exe rerun-failed"`.
 */
export function fillRerun(text, phrase) {
  const cap = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return text.replace(/(^|\. )\{rerun\}/g, (_, p) => p + cap).replace(/\{rerun\}/g, phrase);
}

/** @param {LoadCard[]} cards */
export const failedCards = (cards) => cards.filter((c) => c.state === 'failed');
