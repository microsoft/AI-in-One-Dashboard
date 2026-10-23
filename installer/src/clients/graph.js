// @ts-check
/** Microsoft Graph calls for the app registration and the signed-in user's roles. */
import { GRAPH_APP_ID } from '../catalog.js';
import { HttpError } from '../http.js';

/** Directory roles that can grant admin consent for Microsoft Graph application permissions. */
export const CONSENT_ROLES = {
  '62e90394-69f5-4237-9190-012177145e10': 'Global Administrator',
  'e8611ab8-c189-46e8-94e1-60213ab1f814': 'Privileged Role Administrator',
};

/** Roles that can create app registrations even when users can't. */
export const APP_ROLES = {
  '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3': 'Application Administrator',
  '158c047a-c907-4556-b7ef-446551a6b5f7': 'Cloud Application Administrator',
};

export const FABRIC_ADMIN_ROLE = 'a9ea8996-122f-4c74-9520-8edcd192826c';

/**
 * Maps permission names to Graph app role IDs. A missing required permission is an
 * error; a missing optional one is returned in `missing` so the caller can warn.
 * @param {{ appRoles: { id: string, value: string }[] }} graphSp
 * @param {string[]} permissions
 * @param {string[]} [optional]  Names that may be absent in some tenants (e.g. preview permissions).
 */
export function resolveAppRoles(graphSp, permissions, optional = []) {
  const byValue = new Map(graphSp.appRoles.map((r) => [r.value, r.id]));
  const absent = permissions.filter((p) => !byValue.has(p));
  const fatal = absent.filter((p) => !optional.includes(p));
  if (fatal.length) throw new Error(`Microsoft Graph in this tenant has no application permission named ${fatal.join(', ')}.`);
  const roles = permissions.filter((p) => byValue.has(p)).map((p) => ({ value: p, id: /** @type {string} */ (byValue.get(p)) }));
  return { roles, missing: absent };
}

/**
 * Direct admin-consent link. Entra may show a reply-address error after approval
 * because the app has no redirect URI; the consent still applies.
 * @param {string} tenantId
 * @param {string} appId
 */
export function adminConsentUrl(tenantId, appId) {
  return `https://login.microsoftonline.com/${tenantId}/adminconsent?client_id=${appId}`;
}

/**
 * The app's "API permissions" page in the Entra admin center, with the
 * "Grant admin consent" button.
 * @param {string} appId
 */
export function apiPermissionsUrl(appId) {
  return `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/${appId}`;
}

/**
 * Entra takes a little while to replicate a new app and service principal, so
 * "not found" style 400/404 answers are retried for up to two minutes.
 * @type {import('../http.js').RequestOptions}
 */
const replicationRetry = {
  maxRetries: 20,
  maxWaitMs: 120_000,
  retryIf: (status, data) => (status === 400 || status === 404) && !/already exists/i.test(JSON.stringify(data ?? '')),
};

/** @param {import('../http.js').HttpClient} http */
export function graphApi(http) {
  /** @param {string} path */
  async function getOrNull(path) {
    try {
      return await http.get(path);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /** @param {string} path @param {string} objectId */
  async function addRef(path, objectId) {
    try {
      await http.post(path, { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${objectId}` });
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.status === 400 && /already exist/i.test(JSON.stringify(err.body ?? err.message))) return false;
      throw err;
    }
  }

  return {
    me: () => http.get('/me', { query: { $select: 'id,displayName,userPrincipalName' } }),
    /** @returns {Promise<{ roleTemplateId: string, displayName: string }[]>} */
    myDirectoryRoles: () =>
      http.list('/me/transitiveMemberOf/microsoft.graph.directoryRole', { query: { $select: 'roleTemplateId,displayName' } }),
    /** Whether ordinary users may register apps. */
    usersCanRegisterApps: async () => {
      const policy = await http.get('/policies/authorizationPolicy');
      return policy?.defaultUserRolePermissions?.allowedToCreateApps !== false;
    },
    /** IDs of the groups the signed-in user is in, directly or through other groups. */
    myGroupIds: async () =>
      (await http.list('/me/transitiveMemberOf/microsoft.graph.group', { query: { $select: 'id' } })).map((g) => String(g.id)),
    /** @returns {Promise<{ skuPartNumber?: string, servicePlans?: { servicePlanName: string, provisioningStatus: string }[] }[]>} */
    myLicenseDetails: () => http.list('/me/licenseDetails'),
    /** @returns {Promise<{ skuPartNumber?: string, capabilityStatus?: string, consumedUnits?: number, prepaidUnits?: { enabled?: number }, servicePlans?: { servicePlanName: string, provisioningStatus?: string }[] }[]>} */
    subscribedSkus: () => http.list('/subscribedSkus'),
    /**
     * The tenant's Microsoft 365 report settings. `displayConcealedNames` is true when reports hide user names.
     * Needs ReportSettings.Read.All; a delegated call also needs an admin role such as Reports Reader.
     * https://learn.microsoft.com/graph/api/adminreportsettings-get
     * @returns {Promise<{ displayConcealedNames?: boolean }>}
     */
    reportSettings: () => http.get('/admin/reportSettings'),
    /**
     * Directory roles the user could activate through PIM. Only rows for this principal are kept,
     * whatever the filter returned.
     * @param {string} principalId
     * @returns {Promise<{ roleDefinitionId: string, principalId: string }[]>}
     */
    myEligibleRoles: async (principalId) =>
      (await http.list('/roleManagement/directory/roleEligibilityScheduleInstances', {
        query: { $filter: `principalId eq '${principalId}'`, $select: 'roleDefinitionId,principalId' },
      })).filter((r) => r.principalId === principalId),

    graphServicePrincipal: () =>
      http.get(`/servicePrincipals(appId='${GRAPH_APP_ID}')`, { query: { $select: 'id,appId,appRoles' } }),

    /** @param {string} appId */
    findApplication: (appId) => getOrNull(`/applications(appId='${appId}')`),
    /** @param {string} appId */
    findServicePrincipal: (appId) => getOrNull(`/servicePrincipals(appId='${appId}')`),

    /**
     * @param {string} displayName
     * @param {{ id: string }[]} appRoles
     */
    createApplication: (displayName, appRoles) =>
      http.post('/applications', {
        displayName,
        signInAudience: 'AzureADMyOrg',
        notes: 'Created by the AI in One installer. Its notebooks read the Copilot audit log, Copilot licences and users from Microsoft Graph.',
        requiredResourceAccess: appRoles.length ? [{ resourceAppId: GRAPH_APP_ID, resourceAccess: appRoles.map((r) => ({ id: r.id, type: 'Role' })) }] : [],
      }),
    /**
     * Adds Graph app roles to the app's required permissions, keeping what is there.
     * @param {any} application
     * @param {{ id: string }[]} appRoles
     */
    async ensureRequiredAccess(application, appRoles) {
      const current = /** @type {any[]} */ (application.requiredResourceAccess ?? []);
      const graph = current.find((r) => r.resourceAppId === GRAPH_APP_ID) ?? { resourceAppId: GRAPH_APP_ID, resourceAccess: [] };
      const have = new Set(graph.resourceAccess.map((/** @type {any} */ a) => a.id));
      const add = appRoles.filter((r) => !have.has(r.id));
      if (!add.length) return false;
      graph.resourceAccess = [...graph.resourceAccess, ...add.map((r) => ({ id: r.id, type: 'Role' }))];
      const others = current.filter((r) => r.resourceAppId !== GRAPH_APP_ID);
      await http.patch(`/applications/${application.id}`, { requiredResourceAccess: [...others, graph] });
      return true;
    },

    /** New apps take a few seconds to replicate, so 400/404 are retried briefly. @param {string} appId */
    createServicePrincipal: (appId) => http.post('/servicePrincipals', { appId }, replicationRetry),

    /** @param {string} applicationObjectId */
    deleteApplication: (applicationObjectId) => http.del(`/applications/${applicationObjectId}`),

    /**
     * @param {string} applicationObjectId
     * @param {Date} endDateTime
     * @param {string} [displayName]
     * @returns {Promise<{ secretText: string, endDateTime: string, keyId: string }>}
     */
    addPassword: (applicationObjectId, endDateTime, displayName = 'AI in One installer') =>
      http.post(`/applications/${applicationObjectId}/addPassword`, {
        passwordCredential: { displayName, endDateTime: endDateTime.toISOString() },
      }, { once: true }),
    /**
     * The app's client secrets, without their values.
     * @param {string} applicationObjectId
     * @returns {Promise<{ keyId: string, displayName?: string, endDateTime?: string }[]>}
     */
    listPasswords: async (applicationObjectId) =>
      (await http.get(`/applications/${applicationObjectId}`, { query: { $select: 'passwordCredentials' } })).passwordCredentials ?? [],
    /** @param {string} applicationObjectId @param {string} keyId */
    removePassword: (applicationObjectId, keyId) => http.post(`/applications/${applicationObjectId}/removePassword`, { keyId }),

    /** A user by UPN or email-style sign-in name. Null when there's no such user. @param {string} upn */
    getUser: (upn) => getOrNull(`/users/${encodeURIComponent(upn)}?$select=id,displayName,userPrincipalName`),

    /** @param {string} id */
    getGroup: (id) => getOrNull(`/groups/${encodeURIComponent(id)}?$select=id,displayName,securityEnabled`),
    /** The first group with this exact display name, or null. @param {string} name */
    findGroupByName: async (name) =>
      (await http.list('/groups', { query: { $filter: `displayName eq '${name.replace(/'/g, "''")}'`, $select: 'id,displayName,securityEnabled' } }))[0] ?? null,
    /**
     * Creates a security group (not mail-enabled) owned by `ownerId`, the signed-in user. Entra doesn't make an admin
     * an owner of a security group they create, so the request names them. It does make a user who isn't an admin
     * one, and Graph refuses a request that names them as well, with 400 "Request contains a property with duplicate
     * values". Then the group is created without naming them.
     * @param {{ displayName: string, description: string, ownerId: string }} o
     */
    createSecurityGroup: async (o) => {
      const group = {
        displayName: o.displayName,
        description: o.description,
        mailEnabled: false,
        mailNickname: o.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ai-in-one-viewers',
        securityEnabled: true,
      };
      try {
        return await http.post('/groups', { ...group, 'owners@odata.bind': [`https://graph.microsoft.com/v1.0/users/${o.ownerId}`] });
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 400 || !/property with duplicate values/i.test(JSON.stringify(err.body ?? err.message))) throw err;
        // Graph created nothing, so sending it again can't make a second group.
        return http.post('/groups', group);
      }
    },
    /** Direct members of a group. @param {string} groupId @returns {Promise<{ id: string, displayName?: string, userPrincipalName?: string }[]>} */
    groupMembers: (groupId) => http.list(`/groups/${groupId}/members`, { query: { $select: 'id,displayName,userPrincipalName' } }),
    /** @param {string} groupId @returns {Promise<{ id: string, displayName?: string, userPrincipalName?: string }[]>} */
    groupOwners: (groupId) => http.list(`/groups/${groupId}/owners`, { query: { $select: 'id,displayName,userPrincipalName' } }),
    /** Adds a user or group to a group. Already being a member is fine. @param {string} groupId @param {string} memberId */
    addGroupMember: (groupId, memberId) => addRef(`/groups/${groupId}/members/$ref`, memberId),
    /** @param {string} groupId @param {string} ownerId */
    addGroupOwner: (groupId, ownerId) => addRef(`/groups/${groupId}/owners/$ref`, ownerId),
    /**
     * A user by UPN, or else a group by display name.
     * @param {string} name
     * @returns {Promise<{ id: string, displayName: string, kind: 'user' | 'group' } | null>}
     */
    async resolvePrincipal(name) {
      if (name.includes('@')) {
        const user = await getOrNull(`/users/${encodeURIComponent(name)}?$select=id,displayName,userPrincipalName`);
        if (user) return { id: user.id, displayName: user.userPrincipalName ?? user.displayName, kind: 'user' };
      }
      const group = /^[0-9a-f-]{36}$/i.test(name)
        ? await getOrNull(`/groups/${name}?$select=id,displayName`)
        : (await http.list('/groups', { query: { $filter: `displayName eq '${name.replace(/'/g, "''")}'`, $select: 'id,displayName' } }))[0];
      return group ? { id: group.id, displayName: group.displayName, kind: 'group' } : null;
    },

    /** Makes a user an owner of the app registration. @param {string} applicationObjectId @param {string} userId */
    addOwner: (applicationObjectId, userId) =>
      http.post(`/applications/${applicationObjectId}/owners/$ref`, { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` }),

    /** @param {string} servicePrincipalId */
    appRoleAssignments: (servicePrincipalId) => http.list(`/servicePrincipals/${servicePrincipalId}/appRoleAssignments`),

    /**
     * Grants one application permission (admin consent for that role).
     * @param {string} resourceId  Graph's service principal ID.
     * @param {string} principalId  Our app's service principal ID.
     * @param {string} appRoleId
     */
    grantAppRole: (resourceId, principalId, appRoleId) =>
      http.post(`/servicePrincipals/${resourceId}/appRoleAssignedTo`, { principalId, resourceId, appRoleId }, replicationRetry),

  };
}

/** @typedef {ReturnType<typeof graphApi>} GraphApi */
