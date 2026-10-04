import { world } from './state';

export const getIdleThresholdSec = (): number => world.idleThresholdSec;
export const getIdleWarningSeconds = (): number | null => world.idleWarningSeconds;
export const getScreenshotIntervalSec = (): number => 180;
