import { describe, expect, it } from 'vitest';
import { matchesQuery, normalizeText } from './match';

describe('matchesQuery', () => {
  it('is case- and accent-insensitive', () => {
    expect(normalizeText('  Zoë ')).toBe('zoe');
    expect(matchesQuery(['Zoë Kraft'], 'ZOE')).toBe(true);
  });

  it('needs every term to hit some field', () => {
    expect(matchesQuery(['Anish Suman', 'Engineering'], 'anish eng')).toBe(true);
    expect(matchesQuery(['Anish Suman', 'Engineering'], 'anish design')).toBe(false);
  });

  it('treats a blank query as a match and skips empty fields', () => {
    expect(matchesQuery([null, undefined, ''], '   ')).toBe(true);
    expect(matchesQuery([null, 42], '42')).toBe(true);
  });
});
