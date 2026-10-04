// `tokenStore.ts` as auth.ts imports it: records instead of encrypting.
import { sync } from './syncState';

export const saveTokens = async (tokens: unknown): Promise<void> => {
  sync.savedTokens.push(JSON.parse(JSON.stringify(tokens)));
};
export const loadTokens = async (): Promise<unknown> => sync.tokens;
export const clearTokens = async (): Promise<void> => {
  sync.clearedTokens += 1;
};
