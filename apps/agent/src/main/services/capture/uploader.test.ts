import { describe, expect, it } from 'vitest';
import { HttpError, UnauthorizedError } from '../apiClient';
import {
  UploadTargetError,
  screenshotRetryDelayMs,
  screenshotUploadFailureDecision,
  shouldHoldForEntry,
} from './uploader';

describe('screenshot uploader retry decisions', () => {
  it('uses capped exponential backoff with a one-minute floor', () => {
    expect(screenshotRetryDelayMs(1, () => 0)).toBe(60_000);
    expect(screenshotRetryDelayMs(2, () => 0.5)).toBe(90_000);
    expect(screenshotRetryDelayMs(20, () => 1)).toBe(3_600_000);
  });

  it('does not consume attempts for auth failures', () => {
    const decision = screenshotUploadFailureDecision(
      { attempts: 4 },
      new UnauthorizedError('no_tokens'),
      1_000,
      () => 0,
    );

    expect(decision).toEqual({ action: 'pending', lastError: 'no_tokens', nextAttemptAt: 61_000 });
  });

  it('does not consume attempts when storage is not configured', () => {
    const decision = screenshotUploadFailureDecision(
      { attempts: 4 },
      new HttpError('/v1/screenshots/sign', 503, 'cloudinary_not_configured'),
      1_000,
      () => 0,
    );

    expect(decision).toEqual({
      action: 'pending',
      lastError: '/v1/screenshots/sign 503: cloudinary_not_configured',
      nextAttemptAt: 61_000,
    });
  });

  it('schedules retryable failures below the cap', () => {
    const decision = screenshotUploadFailureDecision(
      { attempts: 1 },
      new Error('network reset'),
      1_000,
      () => 0.5,
    );

    expect(decision).toEqual({ action: 'retry', lastError: 'network reset', nextAttemptAt: 91_000 });
  });

  it('never writes a shot off for a server error, however many times it failed', () => {
    const decision = screenshotUploadFailureDecision(
      { attempts: 40 },
      new HttpError('/v1/screenshots/complete', 500, 'internal_error'),
      1_000,
      () => 0,
    );

    expect(decision).toMatchObject({ action: 'retry', nextAttemptAt: 61_000 });
  });

  it('does not consume attempts while offline or timed out', () => {
    for (const err of [new TypeError('fetch failed'), Object.assign(new Error('timed out'), { name: 'TimeoutError' })]) {
      expect(screenshotUploadFailureDecision({ attempts: 3 }, err, 1_000)).toMatchObject({ action: 'pending' });
    }
  });

  it('treats a definitive API refusal as terminal but an auth bounce as waiting', () => {
    expect(screenshotUploadFailureDecision({ attempts: 0 }, new HttpError('/v1/screenshots/sign', 409, 'screenshot_id_conflict'), 1_000))
      .toMatchObject({ action: 'failed' });
    expect(screenshotUploadFailureDecision({ attempts: 0 }, new HttpError('/v1/screenshots/sign', 401, 'unauthorized'), 1_000))
      .toMatchObject({ action: 'pending' });
  });

  it('treats local missing files and upload-target hard 4xx responses as terminal', () => {
    expect(screenshotUploadFailureDecision({ attempts: 0 }, { code: 'ENOENT', message: 'missing' }, 1_000))
      .toMatchObject({ action: 'failed' });
    expect(screenshotUploadFailureDecision({ attempts: 0 }, new UploadTargetError(401, 'bad signature'), 1_000))
      .toEqual({ action: 'failed', lastError: 'upload target 401: bad signature' });
  });

  it('keeps throttling-style upload-target 4xx responses retryable', () => {
    const decision = screenshotUploadFailureDecision(
      { attempts: 0 },
      new UploadTargetError(429, 'too many requests'),
      1_000,
      () => 0,
    );

    expect(decision).toEqual({ action: 'retry', lastError: 'upload target 429: too many requests', nextAttemptAt: 61_000 });
  });

  it('reads a 503 from the upload target as storage unavailable — no attempt spent', () => {
    // /direct-upload answers a full or broken Drive with 503; the bytes POST
    // bypasses api(), so it arrives as an UploadTargetError, not an HttpError.
    const decision = screenshotUploadFailureDecision(
      { attempts: 2 },
      new UploadTargetError(503, '{"error":"screenshot_storage_unavailable"}'),
      1_000,
      () => 0,
    );
    expect(decision).toMatchObject({ action: 'pending', nextAttemptAt: 61_000 });
  });

  it('reads screenshot_storage_unavailable in any error as storage unavailable', () => {
    const decision = screenshotUploadFailureDecision(
      { attempts: 2 },
      new Error('upload target 500: {"error":"screenshot_storage_unavailable"}'),
      1_000,
    );
    expect(decision.action).toBe('pending');
  });
});

describe('holding a shot for its timer entry', () => {
  const HOUR = 60 * 60_000;
  const pendingCreate = (id: string) => id === 'local-only';

  it('holds a fresh shot whose entry has not reached the server', () => {
    expect(shouldHoldForEntry({ timeEntryId: 'local-only', capturedAt: 0 }, pendingCreate, 10 * 60_000)).toBe(true);
  });

  it('uploads it anyway (detached) once it is an hour old', () => {
    expect(shouldHoldForEntry({ timeEntryId: 'local-only', capturedAt: 0 }, pendingCreate, HOUR)).toBe(false);
  });

  it('never holds a shot whose entry is on the server, or that has none', () => {
    expect(shouldHoldForEntry({ timeEntryId: 'synced', capturedAt: 0 }, pendingCreate, 1)).toBe(false);
    expect(shouldHoldForEntry({ timeEntryId: null, capturedAt: 0 }, pendingCreate, 1)).toBe(false);
  });
});
