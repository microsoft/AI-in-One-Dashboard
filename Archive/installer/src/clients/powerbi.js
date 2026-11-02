// @ts-check
/** Power BI REST API calls for semantic model data sources and refreshes. */

/** @param {import('../http.js').HttpClient} http */
export function powerBiApi(http) {
  return {
    /** @param {string} workspaceId @param {string} datasetId @returns {Promise<any[]>} */
    datasources: async (workspaceId, datasetId) => (await http.get(`/groups/${workspaceId}/datasets/${datasetId}/datasources`))?.value ?? [],
    /** Who has direct access to a semantic model. @param {string} workspaceId @param {string} datasetId @returns {Promise<any[]>} */
    datasetUsers: async (workspaceId, datasetId) => (await http.get(`/groups/${workspaceId}/datasets/${datasetId}/users`))?.value ?? [],
    /**
     * Grants a principal access to a semantic model. ReadExplore is Read plus Build.
     * @param {string} workspaceId @param {string} datasetId
     * @param {{ identifier: string, principalType: 'User' | 'Group' | 'App', datasetUserAccessRight: 'Read' | 'ReadExplore' | 'ReadReshare' | 'ReadReshareExplore' }} body
     */
    addDatasetUser: (workspaceId, datasetId, body) => http.post(`/groups/${workspaceId}/datasets/${datasetId}/users`, body),
    /**
     * Starts an enhanced refresh and returns its request ID.
     * @param {string} workspaceId
     * @param {string} datasetId
     * @param {any} body
     */
    async refresh(workspaceId, datasetId, body) {
      const res = await http.request('POST', `/groups/${workspaceId}/datasets/${datasetId}/refreshes`, { body });
      const location = res.headers.get('location') ?? '';
      const requestId = location.split('/').filter(Boolean).pop() ?? res.headers.get('requestid');
      if (!requestId) throw new Error('Power BI started the refresh but returned no request ID to follow.');
      return requestId;
    },
    /** @param {string} workspaceId @param {string} datasetId @param {string} requestId */
    getRefresh: (workspaceId, datasetId, requestId) => http.get(`/groups/${workspaceId}/datasets/${datasetId}/refreshes/${requestId}`),
    /**
     * Starts a plain refresh, which works in a workspace without a capacity, unlike an enhanced
     * one. Returns the request ID Power BI gave it, or '' when there was none.
     * @param {string} workspaceId @param {string} datasetId
     * @returns {Promise<string>}
     */
    async startRefresh(workspaceId, datasetId) {
      const res = await http.request('POST', `/groups/${workspaceId}/datasets/${datasetId}/refreshes`, { body: { notifyOption: 'NoNotification' } });
      return res.headers.get('requestid') ?? '';
    },
    /** @param {string} workspaceId @param {string} datasetId @param {number} [top] @returns {Promise<any[]>} */
    refreshes: async (workspaceId, datasetId, top = 5) =>
      (await http.get(`/groups/${workspaceId}/datasets/${datasetId}/refreshes`, { query: { $top: top } }))?.value ?? [],
    /**
     * Sets when Power BI refreshes a model by itself
     * (https://learn.microsoft.com/rest/api/power-bi/datasets/update-refresh-schedule-in-group).
     * @param {string} workspaceId @param {string} datasetId
     * @param {{ enabled: boolean, days?: string[], times?: string[], localTimeZoneId?: string, notifyOption?: 'NoNotification' | 'MailOnFailure' }} schedule
     */
    setRefreshSchedule: (workspaceId, datasetId, schedule) =>
      http.patch(`/groups/${workspaceId}/datasets/${datasetId}/refreshSchedule`, { value: schedule }),
    /** @param {string} workspaceId @param {string} datasetId */
    refreshSchedule: (workspaceId, datasetId) => http.get(`/groups/${workspaceId}/datasets/${datasetId}/refreshSchedule`),
    /**
     * Runs a DAX query.
     * @param {string} workspaceId @param {string} datasetId @param {string} query
     * @returns {Promise<any>}
     */
    executeQueries: (workspaceId, datasetId, query) =>
      http.post(`/groups/${workspaceId}/datasets/${datasetId}/executeQueries`, {
        queries: [{ query }],
        serializerSettings: { includeNulls: true },
      }),
  };
}

/** @typedef {ReturnType<typeof powerBiApi>} PowerBiApi */
