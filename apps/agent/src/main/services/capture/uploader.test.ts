import { describe, expect, it } from 'vitest';
import { HttpError, UnauthorizedError } from '../apiClient';
import {
  CloudinaryUploadError,
  screenshotRetryDelayMs,
  screenshotUploadFailureDecision,
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

  it('moves the fifth retryable failure to failed', () => {
    const decision = screenshotUploadFailureDecision({ attempts: 4 }, new Error('network reset'), 1_000);

    expect(decision).toEqual({ action: 'failed', lastError: 'network reset' });
  });

  it('treats local missing files and Cloudinary hard 4xx responses as terminal', () => {
    expect(screenshotUploadFailureDecision({ attempts: 0 }, { code: 'ENOENT', message: 'missing' }, 1_000))
      .toMatchObject({ action: 'failed' });
    expect(screenshotUploadFailureDecision({ attempts: 0 }, new CloudinaryUploadError(401, 'bad signature'), 1_000))
      .toEqual({ action: 'failed', lastError: 'cloudinary 401: bad signature' });
  });

  it('keeps throttling-style Cloudinary 4xx responses retryable', () => {
    const decision = screenshotUploadFailureDecision(
      { attempts: 0 },
      new CloudinaryUploadError(429, 'too many requests'),
      1_000,
      () => 0,
    );

    expect(decision).toEqual({ action: 'retry', lastError: 'cloudinary 429: too many requests', nextAttemptAt: 61_000 });
  });
});
