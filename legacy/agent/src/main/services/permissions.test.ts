import { describe, it, expect } from 'vitest';
import { screenUiState } from './permissions';

describe('screenUiState', () => {
  it('granted + healthy capture → ok', () => {
    expect(screenUiState('granted', 'ok')).toBe('ok');
    expect(screenUiState('granted', 'unknown')).toBe('ok');
  });
  it('granted but blank/error captures → needs-restart (not-yet-effective or revoked)', () => {
    expect(screenUiState('granted', 'empty')).toBe('needs-restart');
    expect(screenUiState('granted', 'error')).toBe('needs-restart');
  });
  it('never asked → needs-grant', () => {
    expect(screenUiState('not-determined', 'unknown')).toBe('needs-grant');
    expect(screenUiState('unknown', 'unknown')).toBe('needs-grant');
  });
  it('denied / restricted → needs-settings', () => {
    expect(screenUiState('denied', 'no-permission')).toBe('needs-settings');
    expect(screenUiState('restricted', 'unknown')).toBe('needs-settings');
  });
});
