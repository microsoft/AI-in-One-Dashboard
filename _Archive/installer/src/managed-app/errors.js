// @ts-check
/**
 * Turns what the managed apps CLI says into who fixes it and how, in a few plain words. The CLI's
 * messages and exit codes are matched, as it prints no stable error codes everywhere. Anything it
 * doesn't recognise falls through to "run it again".
 */
import { commandLine } from '../launch.js';

/** The managed apps CLI's app registration, which Conditional Access may need to allow. */
export const CLI_APP_ID = '9cee029c-6210-4654-90bb-17e6e9d36617';

/** How to run the app's step again, by itself, as this installer was started. */
export const deployAgain = () => commandLine('deploy-app');

export const LINKS = {
  cliSetting: 'https://learn.microsoft.com/microsoft-365/admin/manage/apps/governance#control-whether-apps-can-be-created-using-the-cli',
  licensing: 'https://learn.microsoft.com/microsoft-365/admin/manage/apps/licensing-faq#what-do-administrators-need-to-set-up-so-users-can-run-apps-with-copilot-credits',
  share: 'https://learn.microsoft.com/microsoft-365/managed-apps/developer/share-app',
  portal: 'https://managedapps.cloud.microsoft/',
  node: 'https://nodejs.org/',
  issues: 'https://github.com/microsoft/AI-in-One-Dashboard/issues',
};

/**
 * @typedef {object} Problem
 * @property {string} who  "you", or the admin who fixes it.
 * @property {string} what  What to do.
 * @property {string} [link]
 * @property {string} [message]  What the CLI said.
 * @property {string} [details]  The server's words.
 */

/** The tenant-wide steps only an admin can take. The installer never changes them. */
export const ADMIN_STEPS = /** @type {const} */ ({
  createApps: {
    who: 'Power Platform admin',
    what: 'Turn on "Allow app creation with the Copilot Managed Runtime CLI" for the environment, and check you can create apps in it. Power Platform admin center > Copilot > Settings > Managed apps.',
    link: LINKS.cliSetting,
  },
  externalArtifacts: {
    who: 'Power Platform admin',
    what: 'Turn on "External artifacts in managed apps" for the environment, in the same place. If its environment group has a published rule, change it on the group\'s Rules.',
    link: LINKS.cliSetting,
  },
  licences: {
    who: 'Microsoft 365 admin',
    what: 'Give each viewer Power Apps Premium or Copilot Credits (the Power Apps rights in Microsoft 365 don\'t count). For credits, turn on usage-based billing and add viewers to a spending policy for managed apps.',
    link: LINKS.licensing,
  },
});

/** @typedef {keyof typeof ADMIN_STEPS} AdminStep */

/**
 * @typedef {object} Failure
 * @property {number | null} [exitCode]
 * @property {string} [error]
 * @property {any} [errorData]
 * @property {Record<string, any>} [data]
 * @property {boolean} [timedOut]
 */

const CREATE_APPS = /permission to create an app|grant you the required permission|required privilege|EnvironmentPermissionDenied|InsufficientPrivilege/i;
const EXTERNAL_ARTIFACTS = /external artifact|AllowExternalArtifactDeployment|CodeAppOperationNotAllowedInEnvironment|ExternalArtifactDeploymentDisabled/i;

/**
 * The admin settings a failure says are off: the tenant isn't ready for the app, rather than broken.
 * @param {Failure} result
 * @returns {('createApps' | 'externalArtifacts')[]}
 */
export function notReady(result) {
  const text = [result.error, result.data?.errorCode, result.errorData?.errorCode, result.errorData?.serverMessage]
    .filter((s) => typeof s === 'string')
    .join('\n');
  /** @type {('createApps' | 'externalArtifacts')[]} */
  const found = [];
  if (CREATE_APPS.test(text)) found.push('createApps');
  if (EXTERNAL_ARTIFACTS.test(text)) found.push('externalArtifacts');
  return found;
}

/**
 * Who fixes a failed step, and how.
 * @param {string} step  Which step failed, such as 'init', 'deploy' or 'share'.
 * @param {Failure} result
 * @returns {Problem}
 */
export function explain(step, result) {
  const message = (result.error ?? '').trim();
  const details = detailsOf(result.errorData);
  const problem = (/** @type {Omit<Problem, 'message' | 'details'>} */ fix) => ({
    ...fix,
    ...(message ? { message } : {}),
    ...(details ? { details } : {}),
  });

  if (/AADSTS53003/.test(message)) {
    return problem({
      who: 'Entra admin',
      what: `Conditional Access blocked the sign-in. Allow the managed apps CLI (app ID ${CLI_APP_ID}) in the policy, or sign in from a device it allows.`,
    });
  }
  if (result.timedOut) return problem({ who: 'you', what: `It took too long, so it was stopped. Run ${deployAgain()}: it picks up where it stopped.` });
  if (result.exitCode === 3 || /sign-in session has expired|not signed in|ms auth login/i.test(message)) {
    return problem({ who: 'you', what: `Your sign-in didn't work or has expired. Run ${deployAgain()}, and sign in when it asks.` });
  }
  const off = notReady(result);
  if (off.length) return problem(ADMIN_STEPS[off[0]]);
  if (/failed to resolve a developer environment/i.test(message)) {
    return problem({ who: 'you', what: `Your developer environment couldn't be found. Run ${deployAgain()} again, or add --environment-id with an environment you can make apps in.` });
  }
  if (/environment .*(was )?not found/i.test(message)) {
    return problem({ who: 'you', what: 'That environment wasn\'t found. Check --environment-id, or leave it out to use your own developer environment.' });
  }
  if (/ms\.config\.json already exists/i.test(message)) {
    return problem({ who: 'you', what: `The app's folder already has an app. Run ${deployAgain()} to update that app.` });
  }
  if (/already exists/i.test(message)) {
    return problem({ who: 'you', what: 'An app with that name already exists in the environment. Rename or delete the other one at managedapps.cloud.microsoft, then run it again.', link: LINKS.portal });
  }
  if (/blocked by an environment or tenant policy/i.test(message)) {
    return problem({
      who: 'Power Platform admin',
      what: 'A policy blocks sharing apps in this environment. Allow it, or deploy to another environment with --environment-id.',
      link: LINKS.share,
    });
  }
  if (/sharing request was rejected|sharing limit .*reached/i.test(message)) {
    return problem({ who: 'you', what: 'Check the viewer group is in your organisation, then share the app with it at managedapps.cloud.microsoft.', link: LINKS.share });
  }
  if (result.exitCode === 5 || /could not reach|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(message)) {
    return problem({ who: 'you', what: `It couldn't reach Microsoft. Check your connection or proxy, then run ${deployAgain()}.` });
  }
  if (/temporarily unavailable|too many requests|\b429\b|\b503\b/i.test(message)) {
    return problem({ who: 'you', what: `The service is busy. Wait a few minutes, then run ${deployAgain()}.` });
  }
  return problem({ who: 'you', what: `Run ${deployAgain()}. If it fails the same way, open an issue with the message above.`, link: LINKS.issues });
}

/**
 * The parts of the CLI's errorData worth showing: the server's words.
 * @param {any} errorData
 */
function detailsOf(errorData) {
  if (!errorData || typeof errorData !== 'object') return '';
  return ['serverMessage', 'stderrTail', 'stdoutTail']
    .map((key) => (typeof errorData[key] === 'string' ? errorData[key].trim() : ''))
    .filter(Boolean)
    .join('\n');
}
