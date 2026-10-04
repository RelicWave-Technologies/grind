/**
 * The shared, mutable world the stubs read from. A parity driver sets these
 * fields before it pokes a legacy service, exactly like the `vi.hoisted` state
 * of the legacy unit tests.
 */
export interface StubWorld {
  idleSeconds: number;
  /** `getTimerService().status()` */
  timerStatus: () => unknown;
  idleThresholdSec: number;
  idleWarningSeconds: number | null;
  /** Lines the stub logger received since the driver last emptied this. */
  logs: Array<{ level: string; message: string; meta: unknown }>;
}

export const world: StubWorld = {
  idleSeconds: 0,
  timerStatus: () => ({ state: 'IDLE' }),
  idleThresholdSec: 300,
  idleWarningSeconds: null,
  logs: [],
};
