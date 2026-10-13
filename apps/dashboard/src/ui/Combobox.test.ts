import { describe, expect, it } from 'vitest';
import { comboboxItems, initialActiveIndex, moveActiveIndex, type ComboboxOption } from './Combobox';

const PEOPLE: ComboboxOption[] = [
  { value: 'Anish Suman', label: 'Anish Suman', keywords: ['anish@example.com'] },
  { value: 'Rahul Verma', label: 'Rahul Verma', keywords: ['rahul@example.com'] },
  { value: 'Zoë Kraft', label: 'Zoë Kraft' },
];

const labels = (items: ComboboxOption[]) => items.map((o) => o.label);

describe('comboboxItems', () => {
  it('pins the "All" choice above every option', () => {
    expect(labels(comboboxItems(PEOPLE, '', 'All people'))).toEqual(['All people', 'Anish Suman', 'Rahul Verma', 'Zoë Kraft']);
  });

  it('filters case- and accent-insensitively, by label or keyword', () => {
    expect(labels(comboboxItems(PEOPLE, 'ZOE', 'All people'))).toEqual(['All people', 'Zoë Kraft']);
    expect(labels(comboboxItems(PEOPLE, 'rahul@', 'All people'))).toEqual(['All people', 'Rahul Verma']);
    expect(labels(comboboxItems(PEOPLE, 'verma rahul'))).toEqual(['Rahul Verma']);
  });

  it('leaves only the pinned choice when nothing matches', () => {
    expect(labels(comboboxItems(PEOPLE, 'nobody', 'All people'))).toEqual(['All people']);
    expect(comboboxItems(PEOPLE, 'nobody')).toEqual([]);
  });
});

describe('initialActiveIndex', () => {
  const items = comboboxItems(PEOPLE, '', 'All people');

  it('opens on the current choice', () => {
    expect(initialActiveIndex(items, 'Rahul Verma', '')).toBe(2);
    expect(initialActiveIndex(items, '', '')).toBe(0);
  });

  it('jumps to the first match while searching, so Enter picks it', () => {
    const searched = comboboxItems(PEOPLE, 'zoe', 'All people');
    expect(initialActiveIndex(searched, '', 'zoe')).toBe(1);
  });
});

describe('moveActiveIndex', () => {
  it('walks the list and stops at the ends', () => {
    expect(moveActiveIndex(0, 'ArrowDown', 3)).toBe(1);
    expect(moveActiveIndex(2, 'ArrowDown', 3)).toBe(2);
    expect(moveActiveIndex(0, 'ArrowUp', 3)).toBe(0);
    expect(moveActiveIndex(1, 'End', 3)).toBe(2);
    expect(moveActiveIndex(2, 'Home', 3)).toBe(0);
  });

  it('ignores other keys and empty lists', () => {
    expect(moveActiveIndex(1, 'Enter', 3)).toBeNull();
    expect(moveActiveIndex(0, 'ArrowDown', 0)).toBeNull();
  });
});
