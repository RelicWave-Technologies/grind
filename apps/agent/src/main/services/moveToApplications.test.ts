import { describe, expect, it, vi } from 'vitest';
import { moveToApplications, type MoveToApplicationsDeps } from './moveToApplications';

function deps(patch: Partial<MoveToApplicationsDeps> = {}): MoveToApplicationsDeps {
  return {
    isTracking: () => false,
    confirm: vi.fn().mockResolvedValue(true),
    cleanup: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockReturnValue(true),
    invalidateCleanup: vi.fn(),
    ...patch,
  };
}

describe('move to Applications coordinator', () => {
  it('blocks an active timer before confirmation or cleanup', async () => {
    const d = deps({ isTracking: () => true });

    await expect(moveToApplications(d)).resolves.toEqual({ ok: false, reason: 'TRACKING_ACTIVE' });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.cleanup).not.toHaveBeenCalled();
    expect(d.move).not.toHaveBeenCalled();
  });

  it('does not clean up when the user cancels confirmation', async () => {
    const d = deps({ confirm: vi.fn().mockResolvedValue(false) });

    await expect(moveToApplications(d)).resolves.toEqual({ ok: false, reason: 'CANCELLED' });
    expect(d.cleanup).not.toHaveBeenCalled();
    expect(d.move).not.toHaveBeenCalled();
  });

  it('invalidates early cleanup when an Electron conflict is cancelled', async () => {
    const d = deps({ move: vi.fn().mockReturnValue(false) });

    await expect(moveToApplications(d)).resolves.toEqual({ ok: false, reason: 'CANCELLED' });
    expect(d.cleanup).toHaveBeenCalledTimes(1);
    expect(d.invalidateCleanup).toHaveBeenCalledTimes(1);
  });

  it('invalidates early cleanup when the move fails', async () => {
    const d = deps({ move: vi.fn(() => { throw new Error('move failed'); }) });

    await expect(moveToApplications(d)).resolves.toEqual({ ok: false, reason: 'MOVE_FAILED' });
    expect(d.invalidateCleanup).toHaveBeenCalledTimes(1);
  });
});
