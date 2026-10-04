// `env.ts` as `apiClient.ts` imports it. The real file reads `import.meta.env`,
// which does not exist under Node; only `API_URL` is used and never called here.
export const API_URL = 'http://localhost:4000';
