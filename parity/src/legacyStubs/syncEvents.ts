// `capture/events.ts` as the uploader imports it.
import { sync } from './syncState';

export const broadcastScreenshotChange = (): void => {
  sync.storeCalls.push('broadcast');
};
