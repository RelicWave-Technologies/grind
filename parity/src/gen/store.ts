import type { FnSpec } from '../fixture';
import { specs as activityStore } from './storeActivity';
import { specs as captureStore } from './storeCapture';
import { specs as larkTaskCache } from './storeLark';
import { specs as preferences } from './storePreferences';
import { specs as workspaceTime } from './storeWorkspaceTime';
import { specs as legacyMigration } from './storeMigration';

/**
 * The non-timer persistence layer (`crates/timo-store`): the activity and screenshot
 * queues, the Lark task cache, preferences, the workspace-time cache and the
 * legacy userData migration. Fixtures: `crates/timo-store/tests/fixtures/store/`.
 */
export const specs: FnSpec<any>[] = [...activityStore, ...captureStore, ...larkTaskCache, ...preferences, ...workspaceTime, ...legacyMigration];
