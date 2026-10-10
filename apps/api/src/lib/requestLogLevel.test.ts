import { describe, expect, it } from 'vitest';
import { requestLogLevel } from './requestLogLevel';

describe('requestLogLevel', () => {
  it('keeps successful agent traffic out of the production log', () => {
    expect(requestLogLevel('POST', '/v1/agent/heartbeat', 200)).toBe('debug');
    expect(requestLogLevel('PUT', '/v1/time-entries/01ABC/sync', 200)).toBe('debug');
    expect(requestLogLevel('POST', '/v1/activity-samples', 201)).toBe('debug');
    expect(requestLogLevel('POST', '/v1/screenshots/direct-upload?token=x', 200)).toBe('debug');
    expect(requestLogLevel('POST', '/v1/screenshots/complete', 201)).toBe('debug');
    expect(requestLogLevel('GET', '/healthz', 200)).toBe('debug');
  });

  it('still logs everything else, and every failure', () => {
    expect(requestLogLevel('POST', '/v1/time-entries', 201)).toBe('info');
    expect(requestLogLevel('GET', '/v1/reports/team', 200)).toBe('info');
    expect(requestLogLevel('POST', '/v1/agent/heartbeat', 401)).toBe('warn');
    expect(requestLogLevel('PUT', '/v1/time-entries/01ABC/sync', 409)).toBe('warn');
    expect(requestLogLevel('POST', '/v1/activity-samples', 503)).toBe('error');
    expect(requestLogLevel('POST', '/v1/agent/heartbeat', 200, new Error('x'))).toBe('error');
  });
});
