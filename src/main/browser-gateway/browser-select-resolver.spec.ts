import { describe, expect, it } from 'vitest';
import {
  normalizeSelectText,
  resolveSelectOption,
  selectionMatches,
  summarizeOptions,
  type SelectOptionDescriptor,
} from './browser-select-resolver';

const OPTIONS: SelectOptionDescriptor[] = [
  { value: '', label: 'Please select…' },
  { value: 'gb', label: 'United Kingdom' },
  { value: 'ie', label: 'Ireland' },
  { value: 'us', label: 'United States' },
];

describe('resolveSelectOption', () => {
  it('matches an exact option value first', () => {
    const result = resolveSelectOption(OPTIONS, 'gb');
    expect(result).toEqual({ index: 1, value: 'gb', label: 'United Kingdom', matchedBy: 'value-exact' });
  });

  it('matches an exact visible label when value does not match', () => {
    const result = resolveSelectOption(OPTIONS, 'Ireland');
    expect(result).toMatchObject({ index: 2, matchedBy: 'label-exact' });
  });

  it('matches a label case-insensitively with collapsed whitespace and trailing punctuation', () => {
    const result = resolveSelectOption(OPTIONS, '  united   KINGDOM ');
    expect(result).toMatchObject({ index: 1, matchedBy: 'label-normalized' });
  });

  it('matches a value case-insensitively', () => {
    const result = resolveSelectOption(OPTIONS, 'US');
    expect(result).toMatchObject({ index: 3, matchedBy: 'value-normalized' });
  });

  it('prefers a value match over a label match when both exist', () => {
    // 'ie' is a value here but also collides with nothing as a label.
    const tricky: SelectOptionDescriptor[] = [
      { value: 'ireland', label: 'IE' },
      { value: 'ie', label: 'Ireland' },
    ];
    const result = resolveSelectOption(tricky, 'ie');
    expect(result).toMatchObject({ index: 1, matchedBy: 'value-exact' });
  });

  it('returns null when nothing matches — never guesses', () => {
    expect(resolveSelectOption(OPTIONS, 'Narnia')).toBeNull();
  });

  it('returns null for an empty desired value (would spuriously hit the placeholder)', () => {
    // Desired '' would exact-match the placeholder's value ''; that IS an exact
    // value match and is allowed. But a whitespace-only desired must not
    // normalize-match the placeholder label.
    expect(resolveSelectOption(OPTIONS, '   ')).toBeNull();
  });

  it('returns null for an empty option list', () => {
    expect(resolveSelectOption([], 'gb')).toBeNull();
  });

  it('handles options with no value (custom listbox items)', () => {
    const custom: SelectOptionDescriptor[] = [
      { label: 'Small (1-9)' },
      { label: 'Medium (10-49)' },
      { label: 'Large (50+)' },
    ];
    const result = resolveSelectOption(custom, 'Medium (10-49)');
    expect(result).toMatchObject({ index: 1, matchedBy: 'label-exact' });
  });
});

describe('selectionMatches', () => {
  it('accepts a matching value', () => {
    expect(selectionMatches({ value: 'gb' }, 'gb')).toBe(true);
  });

  it('accepts a matching selected label', () => {
    expect(selectionMatches({ selectedLabel: 'United Kingdom' }, 'United Kingdom')).toBe(true);
  });

  it('accepts a normalized label match after a set', () => {
    expect(selectionMatches({ selectedLabel: 'United Kingdom' }, 'united kingdom')).toBe(true);
  });

  it('rejects a mismatch (the silent no-op case)', () => {
    // Old bug: bridge set .value='gb' on a control that ignored it and kept
    // showing the placeholder. Read-back must catch that.
    expect(selectionMatches({ value: '', selectedLabel: 'Please select…' }, 'gb')).toBe(false);
  });

  it('rejects when state is empty', () => {
    expect(selectionMatches({}, 'gb')).toBe(false);
  });
});

describe('summarizeOptions', () => {
  it('lists value and label for each option', () => {
    expect(summarizeOptions(OPTIONS)).toContain('value="gb"');
    expect(summarizeOptions(OPTIONS)).toContain('label="United Kingdom"');
  });

  it('returns (none) for an empty list', () => {
    expect(summarizeOptions([])).toBe('(none)');
  });

  it('truncates long lists with a remainder count', () => {
    const many: SelectOptionDescriptor[] = Array.from({ length: 25 }, (_, i) => ({
      value: `v${i}`,
      label: `Option ${i}`,
    }));
    expect(summarizeOptions(many, 20)).toContain('5 more');
  });
});

describe('normalizeSelectText', () => {
  it('lowercases, collapses whitespace and strips trailing punctuation', () => {
    expect(normalizeSelectText('  United   Kingdom: ')).toBe('united kingdom');
  });

  it('returns empty string for undefined', () => {
    expect(normalizeSelectText(undefined)).toBe('');
  });
});
