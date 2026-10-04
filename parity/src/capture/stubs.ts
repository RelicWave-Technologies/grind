// Stand-ins for what capture.ts takes from Electron and its neighbours. None of
// them is reached by the pure functions the fixtures call; they only have to exist.
export const desktopCapturer = {};
export const screen = { getAllDisplays: (): unknown[] => [] };
export const app = { getPath: (): string => '/tmp' };
export const SCREENSHOT_QUALITY = 82;
export const SCREENSHOT_MAX_EDGE = 2560;
export const hasScreenAccess = (): boolean => true;
export const serverAlignedNow = (): number => 0;
export const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined };
