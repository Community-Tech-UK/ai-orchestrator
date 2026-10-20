import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import { buildAnchorIndex, buildContinuityPackage, buildUserMessages, realUserMessages } from './compaction-continuity';
import { selectCompactionTail } from './compaction-tail';

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

describe('real user request continuity', () => {
  it.each(['/Users/example/project/src/main.ts\nPlease retain compatibility.', '/tmp', '/my-file.ts\nFix this file.',
    '/unknown-command argument', '/compact/file.ts', '/compactly now', '/prefs.json'])('preserves ordinary slash/path input: %s', ask => {
    const messages = [message('Earlier request'), message(ask)];
    expect(buildUserMessages(messages, 200000).text).toContain(`User: ${ask}`);
    const prepared = buildContinuityPackage({ summary: '', recent: [], messages, contextWindow: 200000,
      stats: { summaryGenerated: false, summarySampledMessages: 0, summaryTotalMessages: 0, skippedRanges: [] } });
    const latest = prepared.text.split('<latest_user_request>')[1]!.split('</latest_user_request>')[0]!;
    expect(latest).toContain(ask);
    expect(latest).not.toContain('Earlier request');
    expect(prepared.stats.userMessages).toBe(2);
  });

  it('excludes exact built-in names/aliases, resolved commands and internal or cross-session input', () => {
    const inputs = ['/compact', '  /CoMpAcT now', '/r auth', '/prefs', '/?'].map(message);
    inputs.push({ ...message('/dynamic-command args'), metadata: { command: { name: 'dynamic-command', resolved: true } } },
      { ...message('Expanded template'), metadata: { command: { name: 'custom', resolved: true } } },
      { ...message('/tmp'), metadata: { internalInput: { actor: 'harness', source: 'compaction-continuity' } } },
      { ...message('/other'), metadata: { crossSessionMessage: { sourceInstanceId: 'fixture-source', sourceDisplayName: 'Fixture source', hopCount: 0 } } },
      message(' <harness_internal_message source="fixture">internal</harness_internal_message>'),
      { ...message('Assistant prose'), type: 'assistant' });
    const ordinary = message('Fix this file');
    expect(realUserMessages([...inputs, ordinary])).toEqual([ordinary]);
  });

  it('retains an older path request verbatim even when it falls outside the selected recent tail', () => {
    const ask = '/tmp/original.ts\nKeep the public interface unchanged.\n- [ ] cover the old client';
    const messages = [message(ask), { ...message('Old reply'), type: 'assistant' as const },
      message('Newest request'), { ...message('Newest reply'), type: 'assistant' as const }];
    const selected = selectCompactionTail(messages.map(item => ({ role: item.type as 'user' | 'assistant', content: item.content })), 200000, 1);
    expect(selected.affectedIndices).toContain(0);
    const prepared = buildContinuityPackage({ summary: 'Summary omits the old ask', recent: selected.keptIndices.map(index => messages[index]!),
      messages, contextWindow: 200000, stats: { summaryGenerated: true, summarySampledMessages: 2, summaryTotalMessages: 2, skippedRanges: [] } });
    const recent = prepared.text.split('<recent_messages>')[1]!.split('</recent_messages>')[0]!;
    const users = prepared.text.split('<user_messages>')[1]!.split('</user_messages>')[0]!;
    expect(recent).not.toContain(ask);
    expect(users).toContain(ask);
    expect(prepared.text.split('<open_user_items>')[1]!.split('</open_user_items>')[0]!).toContain('- [ ] cover the old client');
  });
});
