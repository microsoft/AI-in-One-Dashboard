// @ts-check
/**
 * Read-only checks of what the signed-in user has and lacks for an install: roles, licences,
 * capacities, tenant settings and, for Key Vault, Azure access. Nothing here writes anything, and
 * each check reports "unknown" rather than failing when it can't be read.
 */
import { allowsAction, ROLES } from './clients/azure.js';
import { APP_ROLES, CONSENT_ROLES, FABRIC_ADMIN_ROLE } from './clients/graph.js';
import { secretMode } from './config.js';
import { BIG_CAPACITY_SEATS, copilotLicences, seatCount } from './seats.js';
import { canWriteSecrets } from './steps/identity.js';
import { blockedSettings, CONCEALED_NAMES_SETTING, concealedNames, largeCapacity, runsFabric } from './steps/plan.js';

/** @typedef {'met' | 'missing' | 'eligible' | 'unknown'} PrereqStatus */
/**
 * @typedef {object} Prereq
 * @property {string} id
 * @property {string} label
 * @property {PrereqStatus} status
 * @property {string} detail  What was found.
 * @property {string} neededFor
 * @property {string} howTo  How to get it, when it's missing.
 * @property {boolean} [optional]  Only some features need it.
 * @property {{ name: string, status: PrereqStatus, detail?: string }[]} [rows]  Per subscription or environment.
 */

/** Subscriptions checked one by one; more than this would slow the home screen down. */
export const MAX_SUBSCRIPTIONS = 10;

/** Power BI Pro and Premium Per User service plans. */
const PRO_PLANS = { BI_AZURE_P2: 'Power BI Pro', BI_AZURE_P3: 'Power BI Premium Per User' };

export { COPILOT_PLAN } from './seats.js';

const PIM_URL = 'https://entra.microsoft.com/#view/Microsoft_Azure_PIMCommon/ActivationMenuBlade/~/aadmigratedroles';

const AZURE_ROLE_NAMES = {
  [ROLES.owner]: 'Owner',
  [ROLES.contributor]: 'Contributor',
  [ROLES.userAccessAdministrator]: 'User Access Administrator',
  [ROLES.rbacAdministrator]: 'Role Based Access Control Administrator',
};

/** @param {any} err */
const why = (err) => {
  const status = err?.status ? `${err.status} ` : '';
  const msg = String(err?.message ?? err ?? '').split('\n')[0].slice(0, 160);
  return `${status}${msg}`.trim();
};

/** Last segment of an ARM role definition ID. @param {string} [id] */
const roleGuid = (id) => String(id ?? '').split('/').pop()?.toLowerCase() ?? '';

/**
 * What an ARM permission set lets the user do in a subscription.
 * @param {{ actions?: string[], notActions?: string[] }[]} perms
 */
export function azureAccess(perms) {
  return {
    create: allowsAction(perms, 'Microsoft.Resources/subscriptions/resourceGroups/write') && allowsAction(perms, 'Microsoft.Resources/deployments/write'),
    assign: allowsAction(perms, 'Microsoft.Authorization/roleAssignments/write'),
  };
}

/**
 * Whether Key Vault holds the app secret, or --key-vault asks for it. Only then are Azure roles needed.
 * @param {{ config: import('./config.js').InstallConfig, useKeyVault?: boolean }} ctx
 */
export function keyVaultWanted(ctx) {
  const kv = ctx.config.keyVault;
  return !!ctx.useKeyVault || (secretMode(ctx.config) !== 'notebook' && !!(kv.mode || kv.uri || kv.id));
}

/**
 * @param {{ api: import('./install.js').Apis, user: import('./install.js').User, config: import('./config.js').InstallConfig, useKeyVault?: boolean }} ctx
 * @returns {Promise<Prereq[]>}
 */
export async function checkPrereqs(ctx) {
  const { api, user, config } = ctx;

  const roles = api.graph.myDirectoryRoles();
  const eligible = api.graph.myEligibleRoles(user.id);
  // Unhandled until awaited by a check; these keep a rejected lookup from crashing the process.
  for (const p of [roles, eligible]) p.catch(() => {});
  /** @type {ReturnType<typeof api.graph.myLicenseDetails> | undefined} */
  let licenceList;
  const licences = () => (licenceList ??= api.graph.myLicenseDetails());
  /** @type {ReturnType<typeof api.graph.subscribedSkus> | undefined} */
  let skuList;
  const skus = () => (skuList ??= api.graph.subscribedSkus());
  /** Service plans assigned to the signed-in user and provisioned, by name. */
  const myPlans = async () => (await licences()).flatMap((l) => l.servicePlans ?? []).filter((p) => p.provisioningStatus === 'Success').map((p) => p.servicePlanName);
  /** Assigned Copilot seats, or 0 when they can't be read. */
  const seats = async () => {
    try {
      return copilotLicences(await skus()).assigned;
    } catch {
      return 0;
    }
  };

  /**
   * @param {Omit<Prereq, 'status' | 'detail'>} base
   * @param {() => Promise<Pick<Prereq, 'status' | 'detail'> & Partial<Prereq>>} fn
   * @returns {Promise<Prereq>}
   */
  const guard = async (base, fn) => {
    try {
      return { ...base, ...(await fn()) };
    } catch (err) {
      return { ...base, status: 'unknown', detail: `Couldn't check: ${why(err)}` };
    }
  };

  /**
   * An Entra role: active, one the user can activate through PIM, or missing.
   * @param {Omit<Prereq, 'status' | 'detail'>} base
   * @param {Record<string, string>} wanted  Template ID to name.
   */
  const entraRole = (base, wanted) =>
    guard(base, async () => {
      const active = (await roles).filter((r) => wanted[r.roleTemplateId]);
      if (active.length) return { status: 'met', detail: `Active: ${[...new Set(active.map((r) => wanted[r.roleTemplateId]))].join(', ')}` };
      /** @type {{ roleDefinitionId: string }[] | null} */
      let elig = null;
      try {
        elig = (await eligible).filter((r) => wanted[r.roleDefinitionId]);
      } catch {
        // Reading PIM eligibility needs its own permission; without it, only active roles are known.
      }
      if (elig?.length) {
        return { status: 'eligible', detail: `Not active yet: ${[...new Set(elig.map((r) => wanted[r.roleDefinitionId]))].join(', ')}. You can activate this role in Entra (Privileged Identity Management): ${PIM_URL} Then check again.` };
      }
      return { status: 'missing', detail: `You don't have ${Object.values(wanted).join(' or ')} active.${elig ? '' : ' Couldn\'t check for roles you could activate yourself.'}` };
    });

  /** Owner, or Contributor plus User Access Administrator, per subscription: only for Key Vault. */
  const azureRbac = keyVaultWanted(ctx)
    ? guard(
        {
          id: 'azure-rbac',
          label: 'Azure: Owner, or Contributor and User Access Administrator',
          neededFor: 'Only with Key Vault (--key-vault): creating the vault for the app secret, and giving you access to its secrets.',
          howTo: 'Ask a subscription owner for Owner, or for Contributor and User Access Administrator, on the subscription you\'ll use.',
          optional: true,
        },
        async () => {
          const ids = [user.id, ...(await api.graph.myGroupIds().catch(() => /** @type {string[]} */ ([])))];
          const list = (await api.arm.listSubscriptions()).filter((x) => x.state === 'Enabled');
          if (!list.length) {
            return {
              status: 'missing',
              detail: 'No enabled Azure subscription you can see.',
              howTo: 'Ask for Contributor and User Access Administrator on a subscription. Without one, leave out --key-vault: the app secret goes in the notebooks, where anyone with a role in the workspace can read it.',
            };
          }
          const first = config.keyVault.subscriptionId;
          const ordered = [...list].sort((a, b) => Number(b.subscriptionId === first) - Number(a.subscriptionId === first));
          const rows = await Promise.all(ordered.slice(0, MAX_SUBSCRIPTIONS).map(async (s) => {
            const scope = `/subscriptions/${s.subscriptionId}`;
            const name = s.displayName ?? s.subscriptionId;
            try {
              const access = azureAccess(await api.arm.permissions(scope));
              const assigned = await api.arm.myRoleAssignments(scope, ids).catch(() => []);
              const names = [...new Set(assigned.map((a) => AZURE_ROLE_NAMES[roleGuid(a.properties.roleDefinitionId)]).filter(Boolean))];
              const has = names.length ? ` (${names.join(', ')})` : '';
              if (access.create && access.assign) return { name, status: /** @type {PrereqStatus} */ ('met'), detail: `Can create resources and assign roles${has}` };
              const elig = await api.arm.myEligibleRoles(scope, ids).catch(() => []);
              const eligNames = [...new Set(elig.map((a) => AZURE_ROLE_NAMES[roleGuid(a.properties.roleDefinitionId)]).filter(Boolean))];
              if (eligNames.length) return { name, status: /** @type {PrereqStatus} */ ('eligible'), detail: `Not active yet: ${eligNames.join(', ')}. You can activate it in Privileged Identity Management.` };
              const lacks = access.create ? 'Can create resources but not assign roles (no User Access Administrator)' : access.assign ? 'Can assign roles but not create resources (no Contributor)' : 'Can\'t create resources or assign roles';
              return { name, status: /** @type {PrereqStatus} */ ('missing'), detail: `${lacks}${has}` };
            } catch (err) {
              return { name, status: /** @type {PrereqStatus} */ ('unknown'), detail: `Couldn't check: ${why(err)}` };
            }
          }));
          const status = /** @type {PrereqStatus} */ (['met', 'eligible', 'missing', 'unknown'].find((st) => rows.some((r) => r.status === st)) ?? 'unknown');
          const met = rows.filter((r) => r.status === 'met').length;
          const more = list.length > MAX_SUBSCRIPTIONS ? ` Checked the first ${MAX_SUBSCRIPTIONS} of ${list.length}.` : '';
          return { status, detail: `${met} of ${rows.length} ${rows.length === 1 ? 'subscription' : 'subscriptions'} give you this.${more}`, rows };
        },
      )
    : undefined;

  /** @type {Promise<Prereq>[]} */
  const checks = [
    entraRole(
      {
        id: 'consent-role',
        label: 'Global Administrator or Privileged Role Administrator',
        neededFor: 'Granting admin consent for the app registration\'s Microsoft Graph permissions.',
        howTo: 'If that isn\'t you, carry on: the installer gives you a link for a Global Administrator or Privileged Role Administrator to approve.',
        optional: true,
      },
      CONSENT_ROLES,
    ),
    entraRole(
      {
        id: 'fabric-admin',
        label: 'Fabric administrator — only needed if the tenant settings below are off',
        neededFor: 'Reading and switching on the Fabric tenant settings the model and the report need. If they are already on, you don\'t need this role.',
        howTo: 'Ask a Fabric administrator to check the tenant settings below and turn on any that are off, or ask a Global Administrator for the Fabric Administrator role.',
        optional: true,
      },
      { [FABRIC_ADMIN_ROLE]: 'Fabric Administrator' },
    ),
    guard(
      {
        id: 'register-apps',
        label: 'Register apps in Entra',
        neededFor: 'Creating the app registration that collects the data.',
        howTo: 'Ask for the Application Administrator or Cloud Application Administrator role, use an app registration you already have, or get the admin pack for an admin to register it.',
      },
      async () => {
        if (config.app.appId) return { status: 'met', detail: `Uses the app registration ${config.app.appId}.` };
        const r = await roles;
        const admin = r.find((x) => CONSENT_ROLES[/** @type {keyof typeof CONSENT_ROLES} */ (x.roleTemplateId)] || APP_ROLES[/** @type {keyof typeof APP_ROLES} */ (x.roleTemplateId)]);
        if (admin) return { status: 'met', detail: `Your ${admin.displayName} role allows it.` };
        return (await api.graph.usersCanRegisterApps())
          ? { status: 'met', detail: 'Users in this tenant can register apps.' }
          : { status: 'missing', detail: 'Users in this tenant can\'t register apps, and you have no app admin role.' };
      },
    ),
    guard(
      {
        id: 'power-bi-pro',
        label: 'Power BI Pro or Premium Per User licence',
        neededFor: 'Publishing the semantic model and the report, and sharing the report.',
        howTo: 'Ask your licence admin to assign you Power BI Pro (included in Microsoft 365 E5) or Premium Per User.',
      },
      async () => {
        const found = (await myPlans())
          .map((name) => PRO_PLANS[/** @type {keyof typeof PRO_PLANS} */ (name)])
          .filter(Boolean);
        return found.length
          ? { status: 'met', detail: [...new Set(found)].join(', ') }
          : { status: 'missing', detail: 'No Power BI Pro or Premium Per User licence is assigned to you.' };
      },
    ),
    guard(
      {
        id: 'copilot-licences',
        label: 'Microsoft 365 Copilot licences in the tenant',
        neededFor: 'Licensed Copilot usage. Without Microsoft 365 Copilot licences assigned, only Copilot Chat usage shows.',
        howTo: 'Nothing to do for the install: once Microsoft 365 Copilot licences are assigned, their usage shows after the next load.',
        optional: true,
      },
      async () => {
        const licences = copilotLicences(await skus());
        const names = licences.names.join(', ');
        const { assigned } = licences;
        if (assigned) return { status: 'met', detail: `${seatCount(assigned)} assigned (${names}).` };
        return licences.found
          ? { status: 'missing', detail: `The tenant has ${names}, but none are assigned yet.` }
          : { status: 'missing', detail: 'No Microsoft 365 Copilot licences found in this tenant.' };
      },
    ),
    guard(
      {
        id: 'fabric-capacity',
        label: 'Active Fabric capacity',
        neededFor: 'The AI in One workspace, Lakehouse, notebooks and pipeline run on it.',
        howTo: 'Start a Fabric trial, or ask a capacity admin to make you a contributor on an F2 or larger capacity.',
      },
      async () => {
        const caps = (await api.fabric.listCapacities()).filter((cap) => cap.state === 'Active' && runsFabric(cap));
        if (!caps.length) return { status: 'missing', detail: 'No active Fabric capacity (F2 or larger, or a trial) you can assign workspaces to.' };
        const names = caps.slice(0, 3).map((cap) => `${cap.displayName ?? cap.id}${cap.sku ? ` (${cap.sku})` : ''}`);
        const n = await seats();
        const small = n >= BIG_CAPACITY_SEATS && !caps.some((cap) => largeCapacity(cap))
          ? ` With ${seatCount(n)} Copilot seats assigned, use F64 or larger: on a smaller capacity, loads take longer and may hit their time limits.`
          : '';
        return { status: 'met', detail: `${caps.length} available: ${names.join(', ')}${caps.length > 3 ? ` and ${caps.length - 3} more` : ''}.${small}` };
      },
    ),
    ...(azureRbac
      ? [
          azureRbac,
          guard(
            {
              id: 'key-vault',
              label: 'Key Vault access for the app secret',
              neededFor: 'Keeping the app registration\'s client secret in Azure Key Vault (--key-vault), where the notebooks read it.',
              howTo: 'Ask for Contributor on a subscription to create a vault, or Key Vault Secrets User on an existing one (a vault admin then adds the secret). Or leave out --key-vault: the secret goes in the notebooks, where anyone with a role in the workspace can read it.',
              optional: true,
            },
            async () => {
              const kv = config.keyVault;
              if (kv.id) {
                const vault = await api.arm.getVault(kv.id);
                return (await canWriteSecrets(/** @type {any} */ ({ api, user }), vault))
                  ? { status: 'met', detail: `You can write secrets to ${vault.name ?? kv.name}.` }
                  : { status: 'missing', detail: `You can't write secrets to ${vault.name ?? kv.name}. A vault admin can add the secret for you, or give you Key Vault Secrets Officer.` };
              }
              const rbac = await azureRbac;
              if (rbac.rows?.some((r) => /^Can create resources/.test(r.detail ?? ''))) return { status: 'met', detail: 'You can create a new vault in one of your subscriptions.' };
              if (rbac.status === 'unknown') return { status: 'unknown', detail: 'Couldn\'t check your Azure access.' };
              return { status: rbac.status === 'eligible' ? 'eligible' : 'missing', detail: 'You can\'t create a vault in any subscription you can see. You can use an existing vault you can read, or leave out --key-vault and keep the secret in the notebooks.' };
            },
          ),
        ]
      : []),
    guard(
      {
        id: 'tenant-settings',
        label: 'Fabric tenant settings',
        neededFor: 'The model\'s connection and the report\'s custom visuals each need a tenant setting on.',
        howTo: 'A Fabric administrator switches them on in the admin portal, under Tenant settings.',
      },
      async () => {
        /** @type {any[]} */
        let list;
        try {
          list = await api.fabric.tenantSettings();
        } catch {
          return { status: 'unknown', detail: 'Couldn\'t check: only a Fabric Administrator can read tenant settings.' };
        }
        const off = blockedSettings(Object.fromEntries(list.map((s) => [s.settingName, s])), { reports: true });
        return off.length
          ? { status: 'missing', detail: `Off: ${off.map((s) => s.title).join('; ')}.` }
          : { status: 'met', detail: 'The settings AI in One needs are on.' };
      },
    ),
    guard(
      {
        id: 'concealed-names',
        label: 'Microsoft 365 reports show user names',
        neededFor: 'Matching licensed users to their Copilot activity. While reports conceal user names, the licensed users load with hashed names.',
        howTo: `A Global Administrator can turn concealed names off: ${CONCEALED_NAMES_SETTING}.`,
        optional: true,
      },
      async () => {
        const concealed = await concealedNames(api);
        if (concealed === false) return { status: 'met', detail: 'Reports show user names.' };
        if (concealed) return { status: 'missing', detail: 'Reports conceal user names, so the dashboard gets hashed user names until it\'s turned off.' };
        return { status: 'unknown', detail: `Couldn't check: reading it needs a reports reader or admin role. To check by hand, open ${CONCEALED_NAMES_SETTING}.` };
      },
    ),
  ];
  return Promise.all(checks);
}
