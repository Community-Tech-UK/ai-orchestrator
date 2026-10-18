import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import { buildAnchorIndex, buildContinuityPackage } from './compaction-continuity';

const message = (content: string): OutputMessage => ({ id: 'paths', type: 'user', content, timestamp: 1 });

describe('compaction identifier continuity', () => {
  it('retains exact POSIX, drive, UNC and relative paths through the package', () => {
    const paths = ['/tmp/disposable-probe/a.ts', String.raw`C:\Users\example\src\a.ts`,
      String.raw`\\server\share\src\a.ts`, 'src/main/a.ts', '../src/a.ts'];
    const messages = [message(paths.map(path => `(${path}),`).join(' '))];
    const index = buildAnchorIndex(messages);
    expect(index.count).toBe(paths.length);
    for (const path of paths) expect(index.text).toContain(`- ${path} (1)`);
    const prepared = buildContinuityPackage({ summary: '', recent: [], messages, contextWindow: 200000,
      stats: { summaryGenerated: false, summarySampledMessages: 0, summaryTotalMessages: 0, skippedRanges: [] } });
    const identifiers = prepared.text.split('<identifier_index>')[1]!.split('</identifier_index>')[0]!;
    for (const path of paths) expect(identifiers).toContain(path);
  });

  it('bounds runtime growth for a long slash-free line while retaining ordinary identifiers', () => {
    const run = (length: number) => {
      const input = [message('x'.repeat(length) + ' src/main/a.ts #123 AIO-42 https://example.test/a')];
      const start = performance.now();
      const index = buildAnchorIndex(input);
      const elapsed = performance.now() - start;
      expect(index.count).toBe(4);
      expect(index.text).toContain('src/main/a.ts');
      return elapsed;
    };
    run(1000); // Warm the actual indexing path before comparing growth.
    const small = run(16000);
    const large = run(128000);
    // Eight times the input allows broad scheduling/JIT variance, but rejects
    // the observed ~64x quadratic growth. No machine-specific deadline.
    expect(large).toBeLessThan(Math.max(small, 1) * 24);
  }, 30000);
});
