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

  /**
   * The app's certificates. Asked for on their own, for one app, they come with their public keys,
   * which a change to the list has to send back (https://learn.microsoft.com/graph/api/resources/keycredential).
   * @param {string} applicationObjectId
   * @returns {Promise<any[]>}
   */
  const keyCredentials = async (applicationObjectId) =>
    (await http.get(`/applications/${applicationObjectId}`, { query: { $select: 'keyCredentials' } }))?.keyCredentials ?? [];

  /** A certificate as Graph returned it, ready to send back. @param {any} k */
  const sendBack = (k) => Object.fromEntries(Object.entries(k).filter(([name, v]) => !name.startsWith('@') && v !== null && v !== undefined));

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
     * @param {string} [notes]  What the app is for, shown on its Overview page.
     */
    createApplication: (displayName, appRoles, notes = APP_NOTES) =>
      http.post('/applications', {
        displayName,
        signInAudience: 'AzureADMyOrg',
        notes,
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

    /**
     * Takes Graph app roles off the app's required permissions, keeping the rest.
     * @param {any} application
     * @param {string[]} appRoleIds
     * @returns {Promise<string[]>}  The IDs it took off.
     */
    async removeRequiredAccess(application, appRoleIds) {
      const current = /** @type {any[]} */ (application.requiredResourceAccess ?? []);
      const graph = current.find((r) => r.resourceAppId === GRAPH_APP_ID);
      /** @param {any} a */
      const goes = (a) => a.type === 'Role' && appRoleIds.includes(a.id);
      const removed = /** @type {any[]} */ (graph?.resourceAccess ?? []).filter(goes).map((a) => /** @type {string} */ (a.id));
      if (!removed.length) return [];
      const keep = graph.resourceAccess.filter((/** @type {any} */ a) => !goes(a));
      const others = current.filter((r) => r.resourceAppId !== GRAPH_APP_ID);
      await http.patch(`/applications/${application.id}`, { requiredResourceAccess: [...others, ...(keep.length ? [{ ...graph, resourceAccess: keep }] : [])] });
      return removed;
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

    keyCredentials,
    /**
     * Adds a certificate's public key to the app and returns the new key's ID. A PATCH replaces the
     * whole list, so the app's other certificates are sent back with it
     * (https://learn.microsoft.com/graph/applications-how-to-add-certificate).
     * @param {string} applicationObjectId
     * @param {{ der: string, displayName: string, startDateTime: string, endDateTime: string }} cert  der: the public certificate, base64.
     * @returns {Promise<string>}
     */
    async addCertificate(applicationObjectId, cert) {
      const before = await keyCredentials(applicationObjectId);
      const known = new Set(before.map((k) => k.keyId));
      const added = { type: 'AsymmetricX509Cert', usage: 'Verify', key: cert.der, displayName: cert.displayName, startDateTime: cert.startDateTime, endDateTime: cert.endDateTime };
      await http.patch(`/applications/${applicationObjectId}`, { keyCredentials: [...before.map(sendBack), added] });
      const after = await keyCredentials(applicationObjectId);
      const keyId = after.find((k) => !known.has(k.keyId))?.keyId;
      if (!keyId) throw new Error('Microsoft Entra took the certificate but didn\'t list it on the app.');
      return keyId;
    },
    /**
     * Takes certificates off the app, keeping the others. Returns how many it took off.
     * @param {string} applicationObjectId
     * @param {string[]} keyIds
     */
    async removeCertificates(applicationObjectId, keyIds) {
      const before = await keyCredentials(applicationObjectId);
      const keep = before.filter((k) => !keyIds.includes(k.keyId));
      if (keep.length === before.length) return 0;
      await http.patch(`/applications/${applicationObjectId}`, { keyCredentials: keep.map(sendBack) });
      return before.length - keep.length;
    },

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

    /**
     * Takes one application permission's admin consent away.
     * @param {string} servicePrincipalId  Our app's service principal ID.
     * @param {string} assignmentId
     */
    deleteAppRoleAssignment: (servicePrincipalId, assignmentId) => http.del(`/servicePrincipals/${servicePrincipalId}/appRoleAssignments/${assignmentId}`),

  };
}

/** What the Fabric route's app is for, on its Overview page in Entra. */
export const APP_NOTES = 'Created by the AI in One installer. Its notebooks read the Copilot audit log, Copilot licences and users from Microsoft Graph.';

/**
 * SharePoint calls for the PAX route: finding the site and its document library, and the
 * Sites.Selected permission that lets the app write to that one site. Each call names the site by
 * its address or ID; none searches the tenant.
 * @param {import('../http.js').HttpClient} http  Signed in with a token that has Sites.FullControl.All, to manage the site's permissions.
 */
export function sitesApi(http) {
  return {
    /**
     * @param {string} host  Such as contoso.sharepoint.com.
     * @param {string} path  Such as /sites/AIinOne. Empty for the root site.
     */
    siteByPath: (host, path) => http.get(path ? `/sites/${host}:${path}` : `/sites/${host}`, { query: { $select: 'id,displayName,name,webUrl' } }),
    /** The site's document libraries. @param {string} siteId @returns {Promise<any[]>} */
    drives: (siteId) => http.list(`/sites/${siteId}/drives`, { query: { $select: 'id,name,webUrl,driveType' } }),
    /** Apps with access to the site through Sites.Selected. The list leaves out each one's roles. @param {string} siteId @returns {Promise<any[]>} */
    permissions: (siteId) => http.list(`/sites/${siteId}/permissions`),
    /** One permission, with its roles. @param {string} siteId @param {string} permissionId */
    permission: (siteId, permissionId) => http.get(`/sites/${siteId}/permissions/${permissionId}`),
    /**
     * Gives an app a role on the site (https://learn.microsoft.com/graph/api/site-post-permissions).
     * @param {string} siteId
     * @param {{ appId: string, displayName: string }} app
     * @param {('read' | 'write')[]} roles
     */
    grant: (siteId, app, roles) =>
      http.post(`/sites/${siteId}/permissions`, { roles, grantedToIdentities: [{ application: { id: app.appId, displayName: app.displayName } }] }, { once: true }),
    /** @param {string} siteId @param {string} permissionId @param {('read' | 'write')[]} roles */
    updateGrant: (siteId, permissionId, roles) => http.patch(`/sites/${siteId}/permissions/${permissionId}`, { roles }),
    /** @param {string} siteId @param {string} permissionId */
    revoke: (siteId, permissionId) => http.del(`/sites/${siteId}/permissions/${permissionId}`),
  };
}

/** @typedef {ReturnType<typeof sitesApi>} SitesApi */

/**
 * The site permission that names the app, if there is one.
 * @param {any[]} permissions  As sitesApi().permissions returns them.
 * @param {string} appId
 */
export function appGrant(permissions, appId) {
  const id = appId.toLowerCase();
  const names = (/** @type {any} */ p) => [
    ...(p.grantedToIdentitiesV2 ?? []).map((/** @type {any} */ g) => g?.application?.id),
    ...(p.grantedToIdentities ?? []).map((/** @type {any} */ g) => g?.application?.id),
    p.grantedToV2?.application?.id,
    p.grantedTo?.application?.id,
  ];
  return permissions.find((p) => names(p).some((x) => typeof x === 'string' && x.toLowerCase() === id)) ?? null;
}

/** @typedef {ReturnType<typeof graphApi>} GraphApi */
