import { describe, expect, it } from 'vitest';
import {
  applyTableFilter,
  facetOptions,
  matchesQuery,
  normalizeText,
  readFilterParams,
  writeFilterParams,
  type FilterSpec,
} from './tableFilter';

interface Person {
  name: string;
  email: string;
  role: 'ADMIN' | 'MEMBER';
  team: string | null;
  tags: string[];
}

const PEOPLE: Person[] = [
  { name: 'Anish Suman', email: 'anish@example.com', role: 'ADMIN', team: 'Engineering', tags: ['mac'] },
  { name: 'Zoë Kraft', email: 'zoe@example.com', role: 'MEMBER', team: 'Design', tags: ['win', 'mac'] },
  { name: 'Rahul Verma', email: 'rahul@example.com', role: 'MEMBER', team: null, tags: [] },
];

const SPEC: FilterSpec<Person, 'role' | 'team' | 'tag'> = {
  text: (p) => [p.name, p.email, p.team],
  facets: {
    role: { label: 'Roles', value: (p) => p.role },
    team: { label: 'Teams', value: (p) => p.team },
    tag: { label: 'Tags', value: (p) => p.tags, optionLabel: (v) => v.toUpperCase() },
  },
};

const names = (rows: Person[]) => rows.map((p) => p.name);

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

describe('applyTableFilter', () => {
  it('returns every row, in order, when nothing is chosen', () => {
    expect(names(applyTableFilter(PEOPLE, SPEC, { query: '', facets: {} }))).toEqual(names(PEOPLE));
  });

  it('searches the declared text fields', () => {
    expect(names(applyTableFilter(PEOPLE, SPEC, { query: 'design', facets: {} }))).toEqual(['Zoë Kraft']);
    expect(names(applyTableFilter(PEOPLE, SPEC, { query: 'rahul@', facets: {} }))).toEqual(['Rahul Verma']);
  });

  it('combines text and facets with AND', () => {
    const rows = applyTableFilter(PEOPLE, SPEC, { query: 'example', facets: { role: 'MEMBER', tag: 'mac' } });
    expect(names(rows)).toEqual(['Zoë Kraft']);
  });

  it('treats an empty facet choice as all, and never matches a choice against a missing value', () => {
    expect(applyTableFilter(PEOPLE, SPEC, { query: '', facets: { team: '' } })).toHaveLength(3);
    expect(names(applyTableFilter(PEOPLE, SPEC, { query: '', facets: { team: 'Design' } }))).toEqual(['Zoë Kraft']);
  });
});

describe('facetOptions', () => {
  it('derives distinct, sorted, labelled values from the rows', () => {
    expect(facetOptions(PEOPLE, SPEC.facets!.team)).toEqual([
      { value: 'Design', label: 'Design' },
      { value: 'Engineering', label: 'Engineering' },
    ]);
    expect(facetOptions(PEOPLE, SPEC.facets!.tag)).toEqual([
      { value: 'mac', label: 'MAC' },
      { value: 'win', label: 'WIN' },
    ]);
  });

  it('keeps a fixed option list as given', () => {
    const fixed = [
      { value: 'MEMBER', label: 'Member' },
      { value: 'ADMIN', label: 'Admin' },
    ];
    expect(facetOptions(PEOPLE, { ...SPEC.facets!.role, options: fixed })).toEqual(fixed);
  });
});

describe('URL params', () => {
  it('reads prefixed params, coercing parsed numbers back to strings', () => {
    expect(readFilterParams({ 'm.q': 42, 'm.role': 'ADMIN', other: 'x' }, 'm.', ['role', 'team'])).toEqual({
      query: '42',
      facets: { role: 'ADMIN' },
    });
  });

  it('writes only its own params and drops empty ones', () => {
    const next = writeFilterParams({ sync: 'stuck', q: 'old', team: 'Design' }, '', ['role', 'team'], {
      query: '  ',
      facets: { role: 'ADMIN', team: '' },
    });
    expect(next).toEqual({ sync: 'stuck', role: 'ADMIN' });
  });
});
