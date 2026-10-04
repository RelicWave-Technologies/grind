// `pendingLarkLoginStore.ts` as auth.ts imports it: an in-memory slot.
import { sync } from './syncState';

type Pending = { verifier: string; loginUrl: string; createdAt: number };
export const loadPendingLarkLogin = async (): Promise<Pending | null> => sync.pending;
export const savePendingLarkLogin = async (login: Pending): Promise<void> => {
  sync.pending = { verifier: login.verifier, loginUrl: login.loginUrl, createdAt: login.createdAt };
};
export const clearStoredPendingLarkLogin = async (): Promise<void> => {
  sync.pending = null;
};
