// `workspaceTime.ts` as auth.ts imports it: only the session reset is called.
import { sync } from './syncState';

export const clearWorkspaceTimeSession = (): void => {
  sync.workspaceClears += 1;
};
