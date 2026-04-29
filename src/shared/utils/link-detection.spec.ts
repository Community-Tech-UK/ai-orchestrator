import { describe, expect, it } from 'vitest';
import { detectLinks, type FilePathMeta } from './link-detection';

describe('detectLinks', () => {
  it('detects URLs and trims trailing punctuation', () => {
    expect(detectLinks('Visit https://example.com.')).toEqual([
      expect.objectContaining({ kind: 'url', text: 'https://example.com' }),
    ]);
    expect(detectLinks('http://localhost:3000/foo/bar')[0]).toEqual(
      expect.objectContaining({ kind: 'url', text: 'http://localhost:3000/foo/bar' }),
    );
  });

  it('detects Unix paths with optional line and column', () => {
    const ranges = detectLinks('At /Users/foo/bar.ts:42:7');

    expect(ranges[0]).toEqual(expect.objectContaining({
      kind: 'file-path',
      text: '/Users/foo/bar.ts:42:7',
    }));
    expect(ranges[0].meta).toEqual({
      flavor: 'unix-absolute',
      line: 42,
      column: 7,
    });
  });

  it('does not match key/value style fragments', () => {
    expect(detectLinks('use a/b style')).toEqual([]);
  });

  it('detects Windows absolute, UNC, and relative file paths', () => {
    const windows = detectLinks('Open C:\\Users\\foo\\bar.ts');
    expect(windows[0]).toEqual(expect.objectContaining({ text: 'C:\\Users\\foo\\bar.ts' }));
    expect((windows[0].meta as FilePathMeta).flavor).toBe('windows-absolute');

    const forward = detectLinks('Open D:/x/y/z.ts');
    expect(forward[0]).toEqual(expect.objectContaining({ text: 'D:/x/y/z.ts' }));

    const unc = detectLinks('Open \\\\server\\share\\file.txt');
    expect((unc[0].meta as FilePathMeta).flavor).toBe('unc');

    expect(detectLinks('See ./src/foo.ts for details')[0]).toEqual(
      expect.objectContaining({ kind: 'file-path', text: './src/foo.ts' }),
    );
    expect(detectLinks('Just some/path/here words')).toEqual([]);
  });

  it('detects error traces with line and optional column metadata', () => {
    const ranges = detectLinks('Error\n  at /Users/foo/bar.ts:12:34\n  at /Users/foo/baz.ts:7');

    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual(expect.objectContaining({ kind: 'error-trace' }));
    expect(ranges[0].meta).toEqual({
      path: '/Users/foo/bar.ts',
      flavor: 'unix-absolute',
      line: 12,
      column: 34,
    });
    expect(ranges[1].meta).toEqual({
      path: '/Users/foo/baz.ts',
      flavor: 'unix-absolute',
      line: 7,
      column: undefined,
    });
  });

  it('prefers a URL over any embedded path-like text', () => {
    const ranges = detectLinks('see https://example.com/Users/foo/bar.ts now');

    expect(ranges).toHaveLength(1);
    expect(ranges[0].kind).toBe('url');
  });

  it('returns source-order ranges and respects options', () => {
    expect(detectLinks('first /a/b.ts then https://x.com').map((range) => range.kind))
      .toEqual(['file-path', 'url']);
    expect(detectLinks('', { maxLength: 100 })).toEqual([]);
    expect(detectLinks('x'.repeat(1024), { maxLength: 100 })).toEqual([]);
    expect(detectLinks('see /a/b.ts and https://x.com', { kinds: ['url'] }).map((range) => range.kind))
      .toEqual(['url']);
  });

  it('stays within a conservative performance budget', () => {
    const lines = Array.from({ length: 600 }, (_, i) =>
      `at /Users/foo/file${i}.ts:${i}:${i} see https://x.com/${i}`,
    ).join('\n');
    const startedAt = performance.now();

    const ranges = detectLinks(lines);

    expect(ranges.length).toBeGreaterThan(100);
    expect(performance.now() - startedAt).toBeLessThan(25);
  });
});
