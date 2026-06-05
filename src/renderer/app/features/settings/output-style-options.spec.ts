import { describe, expect, it } from 'vitest';
import { mergeOutputStyleOptions } from './output-style-options';

describe('mergeOutputStyleOptions', () => {
  it('always includes an inert "default" option, even with no input', () => {
    const opts = mergeOutputStyleOptions(undefined, undefined);
    expect(opts).toEqual([{ name: 'default', label: 'Default', source: 'built-in' }]);
  });

  it('keeps built-ins first, then user styles', () => {
    const opts = mergeOutputStyleOptions(
      [
        { name: 'default', label: 'Default' },
        { name: 'concise', label: 'Concise' },
      ],
      [{ name: 'my-style', label: 'My Style', mode: 'replace', filePath: '/x/my-style.md' }],
    );
    expect(opts.map((o) => o.name)).toEqual(['default', 'concise', 'my-style']);
    expect(opts.map((o) => o.source)).toEqual(['built-in', 'built-in', 'user']);
    expect(opts[2]).toMatchObject({ mode: 'replace', filePath: '/x/my-style.md' });
  });

  it('does not duplicate the default when the backend already provides it', () => {
    const opts = mergeOutputStyleOptions([{ name: 'default', label: 'Default' }], []);
    expect(opts.filter((o) => o.name === 'default')).toHaveLength(1);
  });

  it('prepends a default when the backend list omits it', () => {
    const opts = mergeOutputStyleOptions([{ name: 'concise', label: 'Concise' }], []);
    expect(opts[0]).toEqual({ name: 'default', label: 'Default', source: 'built-in' });
    expect(opts.map((o) => o.name)).toEqual(['default', 'concise']);
  });

  it('drops a user style that collides with a built-in name (built-in wins)', () => {
    const opts = mergeOutputStyleOptions(
      [{ name: 'concise', label: 'Concise' }],
      [{ name: 'concise', label: 'Hijacked', filePath: '/x/concise.md' }],
    );
    const concise = opts.filter((o) => o.name === 'concise');
    expect(concise).toHaveLength(1);
    expect(concise[0].source).toBe('built-in');
  });

  it('de-duplicates repeated user style names (first wins)', () => {
    const opts = mergeOutputStyleOptions(
      [{ name: 'default', label: 'Default' }],
      [
        { name: 'dup', label: 'First', filePath: '/a/dup.md' },
        { name: 'dup', label: 'Second', filePath: '/b/dup.md' },
      ],
    );
    const dup = opts.filter((o) => o.name === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ label: 'First', filePath: '/a/dup.md' });
  });

  it('falls back to the name when a label is missing', () => {
    const opts = mergeOutputStyleOptions([{ name: 'x', label: '' }], [{ name: 'y', label: '' }]);
    expect(opts.find((o) => o.name === 'x')?.label).toBe('x');
    expect(opts.find((o) => o.name === 'y')?.label).toBe('y');
  });
});
