import { describe, expect, it } from 'vitest';
import {
  applyTableFilter,
  facetCounts,
  facetOptions,
  personFacets,
  personSearchFields,
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

  it('keeps defaults out of the URL but spells out "all" when it overrides one', () => {
    const defaults = { status: 'PENDING' };
    const write = (status: string) =>
      writeFilterParams({}, '', ['status'], { query: '', facets: { status } }, defaults);
    expect(write('PENDING')).toEqual({});
    expect(write('APPROVED')).toEqual({ status: 'APPROVED' });
    expect(write('')).toEqual({ status: 'all' });
    // …and "all" reads back as an explicit empty choice, overriding the default.
    expect(readFilterParams({ status: 'all' }, '', ['status'])).toEqual({ query: '', facets: { status: '' } });
  });
});

interface Approval {
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reason: string;
  requester: { name: string; email: string; teamName: string | null; role: 'ADMIN' | 'MANAGER' | 'MEMBER' };
}

const RAHUL = { name: 'Rahul Verma', email: 'rahul@example.com', teamName: 'Technical', role: 'MEMBER' as const };
const ZOE = { name: 'Zoë Kraft', email: 'zoe@example.com', teamName: 'Design', role: 'MANAGER' as const };

const APPROVALS: Approval[] = [
  { status: 'APPROVED', reason: 'Client call', requester: RAHUL },
  { status: 'APPROVED', reason: 'Offsite', requester: RAHUL },
  { status: 'PENDING', reason: 'Forgot to start', requester: ZOE },
  { status: 'REJECTED', reason: 'Lunch', requester: RAHUL },
];

const APPROVAL_SPEC: FilterSpec<Approval, 'person' | 'team' | 'role' | 'status'> = {
  text: (a) => [...personSearchFields(a.requester), a.reason],
  facets: {
    ...personFacets((a: Approval) => a.requester),
    status: { label: 'Statuses', value: (a) => a.status },
  },
};

describe('personFacets', () => {
  it('is People · Teams · Roles, in that order, with those labels', () => {
    const facets = personFacets((a: Approval) => a.requester);
    expect(Object.keys(facets)).toEqual(['person', 'team', 'role']);
    expect(Object.values(facets).map((f) => f.label)).toEqual(['People', 'Teams', 'Roles']);
  });

  it('derives its options from the rows only — nobody outside them can appear', () => {
    const facets = personFacets((a: Approval) => a.requester);
    expect(facetOptions(APPROVALS, facets.person)).toEqual([
      { value: 'Rahul Verma', label: 'Rahul Verma' },
      { value: 'Zoë Kraft', label: 'Zoë Kraft' },
    ]);
    expect(facetOptions(APPROVALS, facets.team).map((o) => o.value)).toEqual(['Design', 'Technical']);
    expect(facetOptions(APPROVALS, facets.role)).toEqual([
      { value: 'MANAGER', label: 'Manager' },
      { value: 'MEMBER', label: 'Member' },
    ]);
  });

  it('narrows by team — the "technical team" filter', () => {
    const rows = applyTableFilter(APPROVALS, APPROVAL_SPEC, { query: '', facets: { team: 'Technical' } });
    expect(rows.map((a) => a.reason)).toEqual(['Client call', 'Offsite', 'Lunch']);
  });

  it('gives a row without a person no value to match', () => {
    const facets = personFacets((row: { who: Approval['requester'] | null }) => row.who);
    expect(facetOptions([{ who: null }, { who: RAHUL }], facets.person)).toHaveLength(1);
  });

  it('searches name, email and team', () => {
    const search = (query: string) => applyTableFilter(APPROVALS, APPROVAL_SPEC, { query, facets: {} }).length;
    expect(search('rahul')).toBe(3);
    expect(search('zoe@')).toBe(1);
    expect(search('technical')).toBe(3);
  });
});

describe('facetCounts', () => {
  // The Approvals bug: a reviewer opens on Pending, searches for Rahul, and his
  // requests — all decided — vanish behind the tab with no hint where they are.
  it('finds the matches a facet choice is hiding', () => {
    const state = { query: 'rahul', facets: { status: 'PENDING' } };
    expect(applyTableFilter(APPROVALS, APPROVAL_SPEC, state)).toHaveLength(0);
    const counts = facetCounts(APPROVALS, APPROVAL_SPEC, state, 'status');
    expect(counts.all).toBe(3);
    expect(Object.fromEntries(counts.byValue)).toEqual({ APPROVED: 2, REJECTED: 1 });
  });

  it('still applies every other filter', () => {
    const counts = facetCounts(APPROVALS, APPROVAL_SPEC, { query: '', facets: { team: 'Design', status: 'APPROVED' } }, 'status');
    expect(counts.all).toBe(1);
    expect(Object.fromEntries(counts.byValue)).toEqual({ PENDING: 1 });
  });
});
