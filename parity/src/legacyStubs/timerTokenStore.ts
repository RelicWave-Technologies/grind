// `tokenStore.ts` as `apiClient.ts` imports it (the real one needs Electron's
// safeStorage). `HttpError` never touches it.
export type StoredTokens = { accessToken: string; refreshToken: string; userId: string; workspaceId: string };
export const loadTokens = async (): Promise<StoredTokens | null> => null;
export const replaceTokensIfMatch = async (): Promise<boolean> => false;
export const clearTokensIfMatch = async (): Promise<boolean> => false;
