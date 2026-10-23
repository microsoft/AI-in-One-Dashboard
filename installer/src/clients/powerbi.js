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
    /** @param {string} workspaceId @param {string} datasetId @param {number} [top] @returns {Promise<any[]>} */
    refreshes: async (workspaceId, datasetId, top = 5) =>
      (await http.get(`/groups/${workspaceId}/datasets/${datasetId}/refreshes`, { query: { $top: top } }))?.value ?? [],
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
