import { log } from '../logger';
import { notifyAuth } from './apiClient';
import { refreshAgentConfig } from './agentConfig';
import { startHeartbeat } from './heartbeat';
import { bindTimerToStoredSession, drainTimerSyncNow, refreshTodayLedger } from './timer';

export type SignInSource = 'lark_callback' | 'stored_session';

/**
 * Everything that follows a successful sign-in, in one place.
 *
 * The Lark callback and the "already have a session" button used to run their
 * own hand-copied copies of this and announce the result straight to the
 * renderer — so `loggedIn` never reached the auth listeners, and the work that
 * hangs off it (shift fetch, activity drain, the permission setup offer, the
 * parked app-icon upload) only happened on the next restart.
 *
 * Order matters: the timer is rebound first (closing anything a previous
 * account left open) so nothing below can sync under the wrong owner.
 *
 * @returns false when no session is stored after all.
 */
export async function activateSignedInSession(source: SignInSource): Promise<boolean> {
  if (!await bindTimerToStoredSession(false)) {
    log.warn('sign-in finished without a stored session', { source });
    return false;
  }
  try {
    await drainTimerSyncNow('auth');
  } catch (err) {
    log.warn('sign-in timer drain failed', { source, err: String(err) });
  }
  // Never throws: a failed fetch keeps the current values.
  await refreshAgentConfig();
  void refreshTodayLedger('auth');
  startHeartbeat();
  log.info('signed in', { source });
  notifyAuth('loggedIn');
  return true;
}
