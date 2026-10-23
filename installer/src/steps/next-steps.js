// @ts-check
/**
 * What's left once the installer finishes, as cards for the Done page and the terminal summary:
 * the steps the user does, then hand-offs, each with a message to copy and send to the admin who does it.
 * One list, in the order it should be done, so new steps only need adding here.
 */
import { myGroupsUrl, reportLink, shareReportPending, shareReportSteps, VIEWER_GROUP_NAME } from './access.js';

/**
 * @typedef {object} NextStep
 * @property {string} id  Stable, e.g. "share-report".
 * @property {string} title
 * @property {string} why  Why it matters, in a sentence or two.
 * @property {string} who  Who does it, e.g. "You" or "A Global Administrator".
 * @property {string} [link]
 * @property {string} [linkText]
 * @property {string[]} [steps]  One whole step each, to show numbered.
 * @property {string} [message]  For a hand-off: a message to copy and send to whoever does it.
 * @property {boolean} [optional]
 */

export const M365_ADMIN_URL = 'https://admin.microsoft.com/';

/**
 * A message to someone else: a greeting, the ask, the details, and a sign-off.
 * @param {string[]} body
 * @param {string | undefined} from
 */
const letter = (body, from) => ['Hi,', '', ...body, '', 'Thanks', ...(from ? [from] : [])].join('\n');

/** @param {string[]} steps */
const numbered = (steps) => steps.map((s, i) => `${i + 1}. ${s}`);

/**
 * The cards, in the order to do them: share the report with the viewer group, then ask for user
 * names in Microsoft 365 reports. Empty when nothing is left.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string, upn?: string }} [user]
 * @param {{ concealedNames?: boolean }} [opts]  concealedNames: the tenant check found that Microsoft 365 reports conceal user names.
 * @returns {NextStep[]}
 */
export function nextSteps(config, user = {}, opts = {}) {
  return [shareStep(config, user), concealedNamesStep(user, opts.concealedNames)].filter(/** @returns {s is NextStep} */ (s) => !!s);
}

/**
 * "2 steps left", "1 step left, and 1 optional".
 * @param {NextStep[]} steps
 */
export function stepsLeftTitle(steps) {
  const needed = steps.filter((s) => !s.optional).length;
  const optional = steps.length - needed;
  if (!needed) return `${optional} optional ${optional === 1 ? 'step' : 'steps'}`;
  return `${needed} ${needed === 1 ? 'step' : 'steps'} left${optional ? `, and ${optional} optional` : ''}`;
}

/**
 * The report, until the user says it's shared with the viewer group. Power BI has no API for it.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string }} user
 * @returns {NextStep | null}
 */
function shareStep(config, user) {
  if (!shareReportPending(config)) return null;
  const a = /** @type {import('../config.js').AccessConfig} */ (config.access);
  const group = a.groupName ?? VIEWER_GROUP_NAME;
  return {
    id: 'share-report',
    title: `Share the report with ${group}`,
    why: `Once only. Until it's shared, people in the group can't open the report. After that, give people access by adding them to the group (${myGroupsUrl(/** @type {string} */ (a.groupId))}).`,
    who: 'You',
    link: reportLink(config, user.tenantId),
    linkText: 'Open the report',
    steps: shareReportSteps(config, user.tenantId),
  };
}

/**
 * Microsoft 365 reports that conceal user names, as the tenant check found. The licensed users then
 * load with hashed names, which match nobody's Copilot activity. Only a Global Administrator can show
 * the names: https://learn.microsoft.com/microsoft-365/admin/activity-reports/activity-reports
 * @param {{ upn?: string }} user
 * @param {boolean | undefined} concealed
 * @returns {NextStep | null}
 */
function concealedNamesStep(user, concealed) {
  if (concealed !== true) return null;
  const steps = [
    'In the Microsoft 365 admin center, go to Settings > Org settings and, on the Services tab, choose Reports.',
    'Untick "Conceal user, group, and site names in all reports" and choose Save.',
  ];
  return {
    id: 'concealed-names',
    title: 'Ask for user names in Microsoft 365 reports',
    why: 'Microsoft 365 reports conceal user names, so the licensed users load with hashed names that match nobody\'s Copilot activity. The next pipeline run after the change picks it up.',
    who: 'A Global Administrator',
    link: M365_ADMIN_URL,
    linkText: 'Microsoft 365 admin center',
    steps,
    message: letter(
      [
        'Could you turn off concealed names in Microsoft 365 reports? The AI in One dashboard reads the Microsoft 365 active users report, which gives hashed user names while they\'re concealed, so it can\'t match licences to Copilot activity.',
        '',
        ...numbered(steps),
        '',
        'Only if our privacy practices allow it: showing the names is logged in the Microsoft Purview audit log.',
      ],
      user.upn,
    ),
  };
}
