import { describe, expect, it } from 'vitest';
import { classifyPluginEntrypoint, dedupePluginEntrypoints } from './plugin-entrypoint';

describe('classifyPluginEntrypoint', () => {
  it('classifies TypeScript extensions', () => {
    expect(classifyPluginEntrypoint('/p/index.ts')).toBe('typescript');
    expect(classifyPluginEntrypoint('/p/index.mts')).toBe('typescript');
    expect(classifyPluginEntrypoint('/p/index.cts')).toBe('typescript');
    expect(classifyPluginEntrypoint('/p/INDEX.TS')).toBe('typescript');
  });

  it('classifies everything else as JavaScript', () => {
    expect(classifyPluginEntrypoint('/p/index.js')).toBe('javascript');
    expect(classifyPluginEntrypoint('/p/index.mjs')).toBe('javascript');
    expect(classifyPluginEntrypoint('/p/index.cjs')).toBe('javascript');
    expect(classifyPluginEntrypoint('/p/index')).toBe('javascript');
  });
});

describe('dedupePluginEntrypoints', () => {
  it('prefers the .js sibling over a same-stem .ts', () => {
    const out = dedupePluginEntrypoints(['/p/a/index.ts', '/p/a/index.js']);
    expect(out).toEqual(['/p/a/index.js']);
  });

  it('prefers a compiled .mjs/.cjs sibling over a same-stem .ts', () => {
    expect(dedupePluginEntrypoints(['/p/a/index.ts', '/p/a/index.mjs'])).toEqual(['/p/a/index.mjs']);
    expect(dedupePluginEntrypoints(['/p/a/index.cts', '/p/a/index.cjs'])).toEqual(['/p/a/index.cjs']);
  });

  it('keeps a lone .ts entrypoint', () => {
    expect(dedupePluginEntrypoints(['/p/a/index.ts'])).toEqual(['/p/a/index.ts']);
  });

  it('does not collapse same-basename files in different directories', () => {
    const out = dedupePluginEntrypoints(['/p/a/index.js', '/p/b/index.js']);
    expect(out).toHaveLength(2);
  });

  it('is order-independent when choosing .js over .ts', () => {
    expect(dedupePluginEntrypoints(['/p/a/index.js', '/p/a/index.ts'])).toEqual(['/p/a/index.js']);
    expect(dedupePluginEntrypoints(['/p/a/index.ts', '/p/a/index.js'])).toEqual(['/p/a/index.js']);
  });
});
