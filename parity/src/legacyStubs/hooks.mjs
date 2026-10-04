// Node module-resolution hook that lets the REAL legacy/agent services run
// under plain Node: `electron`, the logger, the environment and the other
// Electron-bound neighbours of a pure service resolve to the small stubs next
// to this file.
//
// Two kinds of rule, both applying only to files under legacy/agent/src/main:
//  - GENERIC: `electron`, `../env`, `../logger` (any depth) are always stubbed.
//    The real env.ts reads `import.meta.env`, which plain Node does not have.
//  - TABLE: [importing file, specifier, stub] redirects one named neighbour of
//    one named file. A service that imports something neither rule knows about
//    still loads the real module, or fails loudly: nothing is mocked silently.
const stubs = new URL('./', import.meta.url);
const MAIN = '/legacy/agent/src/main/';

/** [importing file (relative to legacy/agent/src/main), specifier, stub file] */
const TABLE = [
  ['services/idle/monitor.ts', '../timer', 'timer.ts'],
  ['services/idle/monitor.ts', '../agentConfig', 'agentConfig.ts'],
  ['services/trackingAttention.ts', '../attentionWindow', 'attentionWindow.ts'],
  ['services/quitCleanup.ts', './activity', 'activity.ts'],
  ['services/quitCleanup.ts', './preferences', 'preferences.ts'],
  ['services/quitCleanup.ts', './timer', 'timer.ts'],
  ['services/trackingReadiness.ts', './activity', 'activity.ts'],
  ['services/trackingReadiness.ts', './capture', 'captureIndex.ts'],
  ['services/trackingReadiness.ts', './capture/capture', 'captureCapture.ts'],
  ['services/apiClient.ts', './tokenStore', 'timerTokenStore.ts'],
  // timo-sync parity (gen/sync*.ts): the real auth.ts, activity/sync.ts and capture/uploader.ts.
  ['services/activity/sync.ts', '../apiClient', 'syncApi.ts'],
  ['services/activity/sync.ts', '../../logger', 'logger.ts'],
  ['services/auth.ts', './apiClient', 'syncApi.ts'],
  ['services/auth.ts', '../env', 'syncEnv.ts'],
  ['services/auth.ts', '../logger', 'logger.ts'],
  ['services/auth.ts', './tokenStore', 'syncTokenStore.ts'],
  ['services/auth.ts', './pendingLarkLoginStore', 'syncPendingStore.ts'],
  ['services/auth.ts', './workspaceTime', 'syncWorkspaceTime.ts'],
  ['services/capture/uploader.ts', '../apiClient', 'syncApi.ts'],
  ['services/capture/uploader.ts', '../../logger', 'logger.ts'],
  ['services/capture/uploader.ts', './index', 'syncCaptureIndex.ts'],
  ['services/capture/uploader.ts', './events', 'syncEvents.ts'],
  ['services/capture/uploader.ts', './index', 'captureIndex.ts'],
  ['services/capture/uploader.ts', './events', 'captureEvents.ts'],
  ['services/capture/index.ts', 'better-sqlite3', 'betterSqlite.ts'],
  ['services/capture/index.ts', './store', 'captureStore.ts'],
  ['services/capture/index.ts', './capture', 'captureCapture.ts'],
  ['services/capture/index.ts', './uploader', 'captureUploader.ts'],
  ['services/capture/index.ts', './events', 'captureEvents.ts'],
  ['services/capture/index.ts', '../timer', 'timer.ts'],
  ['services/capture/index.ts', '../workspaceTime', 'workspaceTime.ts'],
  ['services/capture/index.ts', '../activity', 'activity.ts'],
  ['services/capture/index.ts', '../agentConfig', 'agentConfig.ts'],
  ['services/capture/index.ts', '../serverClock', 'serverClock.ts'],
  ['windows/overlay.ts', 'electron', 'electron.ts'],
  // The timer harness (parity/src/scenarios/timerRun.ts): the REAL HttpError/api
  // seam of timerService.ts and syncClient.ts, with env and the network stubbed.
  // Verified against the legacy imports of timerService.ts, syncClient.ts and apiClient.ts: the
  // timer owner's stubs are timerApi.ts, timerEnv.ts, timerApiEnv.ts and timerTokenStore.ts;
  // sqliteStore.ts, todayLedgerStore.ts and serverClock.ts load unstubbed.
  ['services/timer/timerService.ts', '../apiClient', 'timerApi.ts'],
  ['services/timer/syncClient.ts', '../apiClient', 'timerApi.ts'],
  ['services/timer/syncClient.ts', '../../env', 'timerEnv.ts'],
  ['services/apiClient.ts', '../env', 'timerApiEnv.ts'],
];

const GENERIC = [
  [/^electron$/, 'electron.ts'],
  [/^(?:\.\.\/)+env$/, 'env.ts'],
  [/^(?:\.\.\/)+logger$/, 'logger.ts'],
];

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? '';
  const at = parent.indexOf(MAIN);
  if (at !== -1) {
    // `?fresh=n` (see loadLegacyFresh) makes a separate module instance; the table
    // is keyed by the plain path.
    const importer = parent.slice(at + MAIN.length).split('?')[0];
    const hit = TABLE.find(([file, spec]) => file === importer && spec === specifier);
    if (hit) return { url: new URL(hit[2], stubs).href, shortCircuit: true };
    const generic = GENERIC.find(([pattern]) => pattern.test(specifier));
    if (generic) return { url: new URL(generic[1], stubs).href, shortCircuit: true };
  } else if (specifier === 'electron') {
    return { url: new URL('electron.ts', stubs).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
