// @ts-check
/** Fabric REST API calls the installer needs. */

/** @param {string} text */
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * The ref a create puts in the item's description, so the installer can recognise the item after a
 * stopped run. As an object, onAccepted is told Fabric's operation URL if Fabric answers 202.
 * @typedef {string | { text: string, onAccepted?: (operationUrl: string) => void }} ItemRef
 */

/** An item's description, with the ref the installer uses to recognise it after a stopped run. @param {string} description @param {ItemRef} [ref] */
const withRef = (description, ref) => {
  const text = typeof ref === 'string' ? ref : ref?.text;
  return text ? `${description} ${text}` : description;
};

/** @param {ItemRef} [ref] */
const accepted = (ref) => (typeof ref === 'object' ? ref.onAccepted : undefined);

/** @param {string} ipynb */
export function notebookDefinition(ipynb) {
  return {
    format: 'ipynb',
    parts: [{ path: 'notebook-content.ipynb', payload: b64(ipynb), payloadType: 'InlineBase64' }],
  };
}

/** @param {any} pipeline */
export function pipelineDefinition(pipeline) {
  return {
    parts: [{ path: 'pipeline-content.json', payload: b64(JSON.stringify(pipeline, null, 2)), payloadType: 'InlineBase64' }],
  };
}

/**
 * @param {import('../transform/model.js').ModelBim} bim
 * @param {any} pbism
 */
export function semanticModelDefinition(bim, pbism) {
  return {
    parts: [
      { path: 'model.bim', payload: b64(JSON.stringify(bim)), payloadType: 'InlineBase64' },
      { path: 'definition.pbism', payload: b64(JSON.stringify(pbism, null, 2)), payloadType: 'InlineBase64' },
    ],
  };
}

/**
 * A shareable cloud connection to a SQL endpoint that signs in as an app registration.
 * @param {{ displayName: string, server: string, database: string, tenantId: string, clientId: string, clientSecret: string }} o
 */
export function sqlConnectionBody(o) {
  return {
    connectivityType: 'ShareableCloud',
    displayName: o.displayName,
    privacyLevel: 'Organizational',
    connectionDetails: {
      type: 'SQL',
      creationMethod: 'Sql',
      parameters: [
        { dataType: 'Text', name: 'server', value: o.server },
        { dataType: 'Text', name: 'database', value: o.database },
      ],
    },
    credentialDetails: servicePrincipalCredentials(o),
  };
}

/**
 * @param {{ tenantId: string, clientId: string, clientSecret: string }} o
 */
export function servicePrincipalCredentials(o) {
  return {
    singleSignOnType: 'None',
    connectionEncryption: 'Encrypted',
    skipTestConnection: false,
    credentials: {
      credentialType: 'ServicePrincipal',
      tenantId: o.tenantId,
      servicePrincipalClientId: o.clientId,
      servicePrincipalSecret: o.clientSecret,
    },
  };
}

/**
 * @typedef {{ frequency: 'daily' | 'weekly', time: string, weekday: string, timeZone: string }} ScheduleChoice
 */

/**
 * Body for the job scheduler. Starts tomorrow so it never collides with the first load.
 * @param {ScheduleChoice} schedule
 * @param {Date} [now]
 */
export function scheduleBody(schedule, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const end = new Date(Date.UTC(now.getUTCFullYear() + 10, now.getUTCMonth(), now.getUTCDate()));
  const iso = (/** @type {Date} */ d) => d.toISOString().replace(/\.\d{3}Z$/, '');
  /** @type {Record<string, any>} */
  const configuration = {
    startDateTime: iso(start),
    endDateTime: iso(end),
    localTimeZoneId: schedule.timeZone,
    type: schedule.frequency === 'weekly' ? 'Weekly' : 'Daily',
    times: [schedule.time],
  };
  if (schedule.frequency === 'weekly') configuration.weekdays = [schedule.weekday];
  return { enabled: true, configuration };
}

/** @param {import('../http.js').HttpClient} http */
export function fabricApi(http) {
  return {
    listCapacities: () => http.list('/capacities'),
    listWorkspaces: () => http.list('/workspaces'),
    /** @param {string} id */
    getWorkspace: (id) => http.get(`/workspaces/${id}`),
    /**
     * @param {string} displayName
     * @param {string} [capacityId]  Without one, the workspace is a Power BI Pro one, which the PAX route's model needs no more than.
     */
    createWorkspace: (displayName, capacityId) =>
      http.post('/workspaces', { displayName, ...(capacityId ? { capacityId } : {}), description: 'AI in One: Copilot adoption data.' }),
    /**
     * Fabric answers 202 without an operation to follow, so poll the workspace until the assignment finishes.
     * @param {string} workspaceId @param {string} capacityId
     */
    async assignToCapacity(workspaceId, capacityId) {
      await http.post(`/workspaces/${workspaceId}/assignToCapacity`, { capacityId });
      for (let i = 0; i < 60; i++) {
        const ws = await http.get(`/workspaces/${workspaceId}`);
        if (ws?.capacityAssignmentProgress === 'Failed') throw new Error(`Assigning the workspace to capacity ${capacityId} failed.`);
        if (ws?.capacityId?.toLowerCase() === capacityId.toLowerCase() && ws?.capacityAssignmentProgress !== 'InProgress') return null;
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error('Timed out assigning the workspace to the capacity.');
    },

    /** @param {string} workspaceId @returns {Promise<any[]>} */
    listPrivateEndpoints: (workspaceId) => http.list(`/workspaces/${workspaceId}/managedPrivateEndpoints`),
    /** @param {string} workspaceId @param {string} id */
    getPrivateEndpoint: (workspaceId, id) => http.get(`/workspaces/${workspaceId}/managedPrivateEndpoints/${id}`),
    /**
     * @param {string} workspaceId
     * @param {{ name: string, targetPrivateLinkResourceId: string, targetSubresourceType: string, requestMessage: string }} body
     */
    createPrivateEndpoint: (workspaceId, body) => http.post(`/workspaces/${workspaceId}/managedPrivateEndpoints`, body),
    /** @param {string} workspaceId @param {string} id */
    deletePrivateEndpoint: (workspaceId, id) => http.del(`/workspaces/${workspaceId}/managedPrivateEndpoints/${id}`),
    /** Deletes a workspace and everything in it. @param {string} workspaceId */
    deleteWorkspace: (workspaceId) => http.del(`/workspaces/${workspaceId}`),

    /** @param {string} workspaceId @param {string} [type] */
    listItems: (workspaceId, type) => http.list(`/workspaces/${workspaceId}/items`, { query: { type } }),
    /**
     * Deletes an item. Where the tenant allows it, Fabric soft-deletes it first.
     * https://learn.microsoft.com/rest/api/fabric/core/items/delete-item
     * @param {string} workspaceId @param {string} itemId
     */
    deleteItem: (workspaceId, itemId) => http.del(`/workspaces/${workspaceId}/items/${itemId}`),
    /**
     * How a long-running operation is going: NotStarted, Running, Succeeded, Failed or Undefined.
     * Undefined for a URL that isn't Fabric's, as it comes from the install record.
     * @param {string} url  The operation URL Fabric answered a create with.
     * @returns {Promise<string | undefined>}
     */
    operationStatus: async (url) => {
      const host = URL.canParse(url) ? new URL(url) : undefined;
      if (host?.protocol !== 'https:' || !/(^|\.)(fabric\.microsoft\.com|analysis\.windows\.net)$/i.test(host.hostname)) return undefined;
      return (await http.get(url))?.status;
    },
    /** @param {string} workspaceId @returns {Promise<any[]>} */
    listRoleAssignments: (workspaceId) => http.list(`/workspaces/${workspaceId}/roleAssignments`),
    /**
     * @param {string} workspaceId
     * @param {string} principalId
     * @param {'User' | 'Group' | 'ServicePrincipal'} type
     * @param {'Admin' | 'Member' | 'Contributor' | 'Viewer'} role
     */
    addRoleAssignment: (workspaceId, principalId, type, role) =>
      http.post(`/workspaces/${workspaceId}/roleAssignments`, { principal: { id: principalId, type }, role }),
    /**
     * @param {string} workspaceId
     * @param {string} assignmentId
     * @param {'Admin' | 'Member' | 'Contributor' | 'Viewer'} role
     */
    updateRoleAssignment: (workspaceId, assignmentId, role) => http.patch(`/workspaces/${workspaceId}/roleAssignments/${assignmentId}`, { role }),
    /**
     * Needs workspace Admin. https://learn.microsoft.com/rest/api/fabric/core/workspaces/delete-workspace-role-assignment
     * @param {string} workspaceId @param {string} assignmentId
     */
    deleteRoleAssignment: (workspaceId, assignmentId) => http.del(`/workspaces/${workspaceId}/roleAssignments/${assignmentId}`),

    /** Tenant settings. Needs a Fabric administrator; others get 401 or 403. */
    tenantSettings: async () => /** @type {any[]} */ ((await http.get('/admin/tenantsettings'))?.tenantSettings ?? []),

    /** @param {string} workspaceId @param {string} displayName @param {any} definition @param {ItemRef} [ref] */
    createSemanticModel: (workspaceId, displayName, definition, ref) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/semanticModels`, {
        body: { displayName, description: withRef('AI in One: Copilot adoption. Deployed by the AI in One installer.', ref), definition },
        onAccepted: accepted(ref), once: true,
        lroResult: true,
      }),
    /**
     * Replaces the model's definition. By default Fabric keeps the model's data, and turns down
     * (RequiredOptionsMissing) a change it can't make without clearing some. `allowPurgeData` lets
     * it clear that data; only pass it once the user has agreed (see steps/model.js).
     * @param {string} workspaceId @param {string} id @param {any} definition
     * @param {{ allowPurgeData?: boolean }} [opts]
     */
    updateSemanticModel: (workspaceId, id, definition, opts = {}) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/semanticModels/${id}/updateDefinition`, {
        body: opts.allowPurgeData ? { definition, options: { allowPurgeData: true } } : { definition },
      }),
    /** @param {string} workspaceId @param {string} displayName @param {any} definition @param {ItemRef} [ref] */
    createReport: (workspaceId, displayName, definition, ref) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/reports`, {
        body: { displayName, description: withRef('Published by the AI in One installer from its Power BI template.', ref), definition },
        onAccepted: accepted(ref), once: true,
        lroResult: true,
      }),
    /** @param {string} workspaceId @param {string} id @param {any} definition */
    updateReport: (workspaceId, id, definition) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/reports/${id}/updateDefinition`, { body: { definition } }),
    /**
     * Points the model's data source at a connection.
     * @param {string} workspaceId
     * @param {string} id
     * @param {{ id: string, type: string, path: string }} connection
     */
    bindConnection: (workspaceId, id, connection) =>
      http.post(`/workspaces/${workspaceId}/semanticModels/${id}/bindConnection`, {
        connectionBinding: {
          id: connection.id,
          connectivityType: 'ShareableCloud',
          connectionDetails: { type: connection.type, path: connection.path },
        },
      }),

    /** @returns {Promise<any[]>} */
    listConnections: () => http.list('/connections'),
    /** @param {string} id */
    getConnection: (id) => http.get(`/connections/${id}`),
    /** @param {any} body */
    createConnection: (body) => http.post('/connections', body, { once: true }),
    /** @param {string} id @param {any} body */
    updateConnection: (id, body) => http.patch(`/connections/${id}`, body, { once: true }),
    /** @param {string} id */
    deleteConnection: (id) => http.del(`/connections/${id}`),

    /**
     * Whether the workspace is connected to Git. Needs Contributor or higher.
     * @param {string} workspaceId
     * @returns {Promise<{ gitConnectionState: 'NotConnected' | 'Connected' | 'ConnectedAndInitialized', gitProviderDetails?: any }>}
     */
    getGitConnection: (workspaceId) => http.get(`/workspaces/${workspaceId}/git/connection`),

    /** @param {string} workspaceId @param {string} id */
    getLakehouse: (workspaceId, id) => http.get(`/workspaces/${workspaceId}/lakehouses/${id}`),
    /** @param {string} workspaceId @param {string} displayName @param {ItemRef} [ref] */
    createLakehouse: (workspaceId, displayName, ref) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/lakehouses`, {
        body: { displayName, description: withRef('AI in One tables.', ref), creationPayload: { enableSchemas: true } },
        onAccepted: accepted(ref), once: true,
        lroResult: true,
      }),

    /** @param {string} workspaceId @param {string} displayName @param {string} ipynb @param {ItemRef} [ref] */
    createNotebook: (workspaceId, displayName, ipynb, ref) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/notebooks`, {
        body: { displayName, description: withRef('Deployed by the AI in One installer.', ref), definition: notebookDefinition(ipynb) },
        onAccepted: accepted(ref), once: true,
        lroResult: true,
      }),
    /** @param {string} workspaceId @param {string} id @param {string} ipynb */
    updateNotebook: (workspaceId, id, ipynb) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/notebooks/${id}/updateDefinition`, { body: { definition: notebookDefinition(ipynb) } }),

    /** @param {string} workspaceId @param {string} displayName @param {any} pipeline @param {ItemRef} [ref] */
    createPipeline: (workspaceId, displayName, pipeline, ref) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/dataPipelines`, {
        body: { displayName, description: withRef('AI in One data load.', ref), definition: pipelineDefinition(pipeline) },
        onAccepted: accepted(ref), once: true,
        lroResult: true,
      }),
    /** @param {string} workspaceId @param {string} id @param {any} pipeline */
    updatePipeline: (workspaceId, id, pipeline) =>
      http.requestLro('POST', `/workspaces/${workspaceId}/dataPipelines/${id}/updateDefinition`, {
        body: { definition: pipelineDefinition(pipeline) },
      }),

    /**
     * Starts a job and returns the URL to poll.
     * @param {string} workspaceId
     * @param {string} itemId
     * @param {'Pipeline' | 'RunNotebook'} jobType
     * @param {any} [executionData]
     */
    async runJob(workspaceId, itemId, jobType, executionData) {
      const res = await http.request('POST', `/workspaces/${workspaceId}/items/${itemId}/jobs/instances`, {
        query: { jobType },
        body: executionData ? { executionData } : undefined,
      });
      const location = res.headers.get('location');
      if (!location) throw new Error('Fabric started the job but returned no job instance to follow.');
      return location;
    },
    /** @param {string} jobUrl */
    getJob: (jobUrl) => http.get(jobUrl),
    /** @param {string} workspaceId @param {string} itemId @param {string} jobId */
    jobUrl: (workspaceId, itemId, jobId) => `/workspaces/${workspaceId}/items/${itemId}/jobs/instances/${jobId}`,
    /** @param {string} workspaceId @param {string} itemId */
    listJobs: (workspaceId, itemId) => http.list(`/workspaces/${workspaceId}/items/${itemId}/jobs/instances`),
    /**
     * The activity runs of one pipeline run. A retried activity can appear once per attempt.
     * @param {string} workspaceId
     * @param {string} jobId
     * @param {Date} after
     * @param {Date} before
     * @returns {Promise<any[]>}
     */
    async queryActivityRuns(workspaceId, jobId, after, before) {
      /** @type {any[]} */
      const out = [];
      /** @type {string | undefined} */
      let continuationToken;
      for (let page = 0; page < 50; page++) {
        const res = await http.post(`/workspaces/${workspaceId}/datapipelines/pipelineruns/${jobId}/queryactivityruns`, {
          filters: [],
          orderBy: [{ orderBy: 'ActivityRunStart', order: 'ASC' }],
          lastUpdatedAfter: after.toISOString(),
          lastUpdatedBefore: before.toISOString(),
          ...(continuationToken ? { continuationToken } : {}),
        });
        out.push(...(Array.isArray(res) ? res : (res?.value ?? [])));
        continuationToken = Array.isArray(res) ? undefined : res?.continuationToken;
        if (!continuationToken) break;
      }
      return out;
    },

    /**
     * The pipeline's saved definition, parsed from `pipeline-content.json`.
     * @param {string} workspaceId
     * @param {string} id
     * @returns {Promise<any>}
     */
    async getPipelineDefinition(workspaceId, id) {
      const res = await http.requestLro('POST', `/workspaces/${workspaceId}/dataPipelines/${id}/getDefinition`, { lroResult: true });
      const part = res?.definition?.parts?.find((/** @type {any} */ p) => p.path === 'pipeline-content.json');
      if (!part?.payload) throw new Error('Fabric returned the pipeline without its definition.');
      return JSON.parse(Buffer.from(part.payload, 'base64').toString('utf8'));
    },

    /** Spark settings of a workspace. Needs workspace Admin. @param {string} workspaceId */
    getSparkSettings: (workspaceId) => http.get(`/workspaces/${workspaceId}/spark/settings`),
    /** @param {string} workspaceId @param {any} body  Only the settings to change. */
    updateSparkSettings: (workspaceId, body) => http.patch(`/workspaces/${workspaceId}/spark/settings`, body),

    /** @param {string} workspaceId @param {string} itemId */
    listSchedules: (workspaceId, itemId) => http.list(`/workspaces/${workspaceId}/items/${itemId}/jobs/Pipeline/schedules`),
    /** @param {string} workspaceId @param {string} itemId @param {any} body */
    createSchedule: (workspaceId, itemId, body) => http.post(`/workspaces/${workspaceId}/items/${itemId}/jobs/Pipeline/schedules`, body),
    /** @param {string} workspaceId @param {string} itemId @param {string} scheduleId @param {any} body */
    updateSchedule: (workspaceId, itemId, scheduleId, body) =>
      http.patch(`/workspaces/${workspaceId}/items/${itemId}/jobs/Pipeline/schedules/${scheduleId}`, body),
  };
}

/** @typedef {ReturnType<typeof fabricApi>} FabricApi */
