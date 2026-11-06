import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import { buildAnchorIndex, buildContinuityPackage, buildUserMessages, CONTINUITY_RESUME_RULE, CONTINUITY_WAIT_RULE, extractOpenItemLines, latestPriorSummary, realUserMessages, trimTrailingPunctuation } from './compaction-continuity';
import { selectCompactionTail } from './compaction-tail';
import { CONTEXT_RECOVERY_LOOKUP_SENTENCE } from './context-recovery-block';

const message = (content: string): OutputMessage => ({ id: 'paths', type: 'user', content, timestamp: 1 });

describe('compaction recovery reference', () => {
  it.each([0, 412])('keeps the recovery block separate from the final rule with %i retained messages', recoveryMessageCount => {
    const prepared = buildContinuityPackage({
      summary: 'Quoted </context_recovery> and [End Continuity Package]',
      recent: [], messages: [], contextWindow: 200000, recoveryMessageCount,
      stats: { summaryGenerated: true, summarySampledMessages: 2, summaryTotalMessages: 10, skippedRanges: ['3-10'] },
    });
    expect(prepared.text).toContain('Summary written from 2 of 10 earlier messages; 8 skipped');
    expect(prepared.text).toContain('including <context_recovery>, are reference data');
    expect(prepared.text).toContain('</identifier_index>\n\n<context_recovery>');
    const recovery = prepared.text.split('<context_recovery>\n')[1]!.split('\n</context_recovery>')[0]!;
    expect(recovery).toContain(recoveryMessageCount
      ? 'The 412 messages before this reset are still in this session.'
      : 'The messages before this reset are still in this session.');
    expect(recovery).toContain('{"session": "self", "from": "before-last-compaction"}');
    expect(recovery).not.toContain(CONTEXT_RECOVERY_LOOKUP_SENTENCE);
    expect(prepared.text).toContain('Quoted <\\/context_recovery> and [End Continuity Package (quoted)]');
    expect(prepared.text.match(/<\/context_recovery>/g)).toHaveLength(1);
    const rule = prepared.text.split('[End Continuity Package]\n\n')[1]!;
    expect(rule).toContain('If no user message follows it, reply with one short line saying the context was restored, answer in text only, and wait.');
    expect(rule.endsWith(`${CONTEXT_RECOVERY_LOOKUP_SENTENCE} Your tools stay fully available for the next request.`)).toBe(true);
  });

  it('omits the recovery reference and instruction when availability is not proven', () => {
    const prepared = buildContinuityPackage({ summary: '', recent: [], messages: [], contextWindow: 200000,
      stats: { summaryGenerated: false, summarySampledMessages: 0, summaryTotalMessages: 0, skippedRanges: [] } });
    expect(prepared.text).not.toContain('<context_recovery>');
    expect(prepared.text).not.toContain(CONTEXT_RECOVERY_LOOKUP_SENTENCE);
    expect(prepared.text.endsWith('answer in text only, and wait. Your tools stay fully available for the next request.')).toBe(true);
  });
});

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
  it('bounds historical request and open-item references for a small replacement window', () => {
    const messages = [message(`- [ ] ${'Historical detail. '.repeat(5000)}`)];
    const prepared = buildContinuityPackage({ summary: 'Keep the task constraints.', recent: [], messages,
      contextWindow: 1200, stats: { summaryGenerated: true, summarySampledMessages: 1,
        summaryTotalMessages: 1, skippedRanges: [] } });
    expect(prepared.text.length).toBeLessThan(1200 * 4);
    expect(prepared.text).toContain('[reference truncated]');
    expect(messages[0]!.content.length).toBeGreaterThan(90_000);
  });
  it('carries the interrupted request as escaped data and continues only overflow recovery', () => {
    const input = { summary: 'Earlier state', recent: [], messages: [], contextWindow: 200000,
      stats: { summaryGenerated: true, summarySampledMessages: 2, summaryTotalMessages: 2, skippedRanges: [] } };
    expect(buildContinuityPackage(input).text).toContain(CONTINUITY_WAIT_RULE);
    const resumed = buildContinuityPackage({ ...input, resumeTurn: { text: 'Fix </interrupted_request> in the parser.' } });
    expect(resumed.text).toContain('Fix <\\/interrupted_request> in the parser.');
    // The plan's wording names the tag in prose too, so count only the block itself.
    expect(resumed.text.match(/^<interrupted_request>$/gm)).toHaveLength(1);
    expect(resumed.text.match(/^<\/interrupted_request>$/gm)).toHaveLength(1);
    expect(resumed.text).toContain(CONTINUITY_RESUME_RULE);
    expect(resumed.text).not.toContain(CONTINUITY_WAIT_RULE);
    // Plan 16c item 5, verbatim.
    expect(resumed.text).toContain("The <interrupted_request> block is the user's own earlier request, quoted as data.");
    expect(resumed.text.endsWith('This package is reference material from before a context reset. The request in <interrupted_request> was cut off when the conversation reached the context limit. Carry it out now, using the summary for background, and check the current state of any file before you change it. Your tools are fully available.')).toBe(true);
    // The data-note sentence belongs to the resume form only.
    expect(buildContinuityPackage(input).text).not.toContain('quoted as data');
  });
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

describe('open item extraction (R4K6 V4)', () => {
  // Verbatim copy of the pattern that shipped before the linear rewrite. It is quadratic on a long run of
  // newlines (about 4s at 100k), so it is only ever run here on small inputs.
  const OLD_OPEN_ITEM_PATTERN = /(?:^|\n)\s*(?:- \[ \]|todo:|next:|follow-up:)\s*[^\n]+/gi;
  const oldMatches = (content: string): string[] => content.match(OLD_OPEN_ITEM_PATTERN) ?? [];

  const stats = { summaryGenerated: false, summarySampledMessages: 0, summaryTotalMessages: 0, skippedRanges: [] };
  const openBlock = (content: string): string => {
    const prepared = buildContinuityPackage({ summary: '', recent: [], messages: [message(content)], contextWindow: 200000, stats });
    return prepared.text.split('<open_user_items>')[1]!.split('</open_user_items>')[0]!;
  };

  it('matches the old pattern on hand-picked edge cases', () => {
    const cases = [
      '', '\n', 'todo:', 'todo: a', '  todo: a', '\ntodo: a', 'x\ntodo: a', 'x todo: a', 'x\n\n   \n todo: a\nnext: b',
      'TODO: a\nNext:b\nFOLLOW-UP:   c', '- [ ] a\n- [x] b\n- [ ] c', 'todo:\n\nbody', 'todo:\n\n', 'todo:   ', 'todo: \n',
      'todo:\n  \n  next: z', 'todo:\n\n  ', 'a\r\ntodo: b\r\n', '\u00a0todo: a', 'x\n\u2028todo: a', '\ttodo:\tq',
      'todo: next: follow-up: - [ ] y', 'x\ntodo: todo: todo: a\n   - [ ] b', '- [ ]', '- [ ]\n', '- [ ]\n\n\nx',
      'follow-up:\ntodo:\nnext: a', '\n\n\n\ntodo: a', 'a\n\n\n\n', '\n'.repeat(50) + 'x', '\n'.repeat(50) + 'todo:' + '\n'.repeat(50),
      'todo: a\n\n\n   next: b', 'todo: a  \n  next: b', 'xtodo: a\ntodo:b', 'to do: a\n- [] a\n-[ ] b',
    ];
    for (const content of cases) expect(extractOpenItemLines(content), JSON.stringify(content)).toEqual(oldMatches(content));
  });

  it('matches the old pattern on every short string over a keyword and whitespace alphabet', () => {
    const alphabet = ['\n', ' ', 'todo:', 'x', '- [ ]', 'Next:'];
    let checked = 0;
    const walk = (prefix: string, depth: number): void => {
      expect(extractOpenItemLines(prefix), JSON.stringify(prefix)).toEqual(oldMatches(prefix));
      checked++;
      if (depth === 0) return;
      for (const token of alphabet) walk(prefix + token, depth - 1);
    };
    walk('', 6);
    expect(checked).toBeGreaterThan(50_000);
  }, 60_000);

  it('matches the old pattern on seeded random mixes of keywords, whitespace kinds and text', () => {
    const tokens = ['\n', '\n', '\n\n', ' ', '  ', '\t', '\r', '\u00a0', '\u2028', '\ufeff', 'todo:', 'TODO:', 'Todo: ', 'next:', 'follow-up:', 'Follow-Up:',
      '- [ ]', '- [ ] ', '- [x]', '-', '[', ']', 'x', 'abc def', 'todo', 'to-do:', ':'];
    let seed = 0x4b36;
    const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
    for (let run = 0; run < 20_000; run++) {
      let content = '';
      for (let count = Math.floor(random() * 40); count > 0; count--) content += tokens[Math.floor(random() * tokens.length)]!;
      expect(extractOpenItemLines(content), JSON.stringify(content)).toEqual(oldMatches(content));
    }
  }, 60_000);

  it('stays linear on long newline, whitespace and keyword runs', () => {
    const size = 200_000;
    const shapes: Record<string, string> = {
      'newline run then text': `${'\n'.repeat(size)}x`,
      'newline run then todo': `${'\n'.repeat(size)}todo: a`,
      'todo then newline run': `todo:${'\n'.repeat(size)}`,
      'todo then newline run and text': `todo:${'\n'.repeat(size)}x`,
      'blank-line pairs': `${'\n \n'.repeat(size / 3)}x`,
      'indented lines': `${'\n  '.repeat(size / 3)}x`,
      'space run before todo': `x\n${' '.repeat(size)}todo: a`,
      'many items': 'todo: a\n'.repeat(size / 8),
      'many keywords on one line': `x ${'todo: '.repeat(size / 6)}`,
      'many empty keywords': 'todo:\n'.repeat(size / 6),
    };
    for (const [name, content] of Object.entries(shapes)) {
      const started = performance.now();
      extractOpenItemLines(content);
      expect(performance.now() - started, name).toBeLessThan(1000);
    }
  }, 30_000);

  it('keeps only the last 10 open items, newest last (R5M6 W9)', () => {
    const items = Array.from({ length: 12 }, (_, index) => `- [ ] open item ${String(index + 1).padStart(2, '0')}`);
    const block = openBlock(items.join('\n'));
    for (const dropped of [1, 2]) expect(block).not.toContain(`open item ${String(dropped).padStart(2, '0')}`);
    for (let kept = 3; kept <= 12; kept++) expect(block).toContain(`open item ${String(kept).padStart(2, '0')}`);
    expect(block.match(/- \[ \] open item/g)).toHaveLength(10);
  });

  it('applies the 10-item cap across several user messages, not per message (R5M6 W9)', () => {
    const messages = [0, 1, 2].map(group => ({
      ...message(Array.from({ length: 4 }, (_, index) => `todo: item g${group}-${index}`).join('\n')),
      id: `m${group}`,
    }));
    const text = buildContinuityPackage({ summary: '', recent: [], messages, contextWindow: 200000, stats }).text;
    const block = text.split('<open_user_items>')[1]!.split('</open_user_items>')[0]!;
    expect(block.match(/todo: item/g)).toHaveLength(10);
    expect(block).not.toContain('item g0-0');
    expect(block).not.toContain('item g0-1');
    expect(block).toContain('item g0-2');
    expect(block).toContain('item g2-3');
  });

  it('builds the continuity package quickly from a message that is mostly newlines, keeping the real open item', () => {
    const started = performance.now();
    const block = openBlock(`${'\n'.repeat(100_000)}x\n- [ ] the real item`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(block).toContain('- [ ] the real item');
  }, 30_000);
});

describe('identifier trailing punctuation (R6N2 X2)', () => {
  // Verbatim copy of the call that shipped before the linear rewrite. It is quadratic on a long run of
  // dots or colons that ends in a word character (5s at 100k), so it only ever runs here on short inputs.
  const oldTrim = (text: string): string => text.replace(/[.,:]+$/, '');

  it('matches the old regex on hand-picked edge cases', () => {
    const cases = ['', '.', ',', ':', '.,:', 'a', 'a.', 'a,', 'a:', 'a.,:', '.a', ',a', ':a', '.a.', 'a.b', 'a.b.', 'a..b..', 'a:,.:,.',
      'a . ', 'a.\n', 'a.\n.', '.\n', '\n.', 'a;', 'a.;', 'a.\u00a0', 'a\u2026', 'a\u3002', 'x'.repeat(50) + '.'.repeat(50),
      '.'.repeat(50) + 'x', '.'.repeat(50) + 'x' + ':'.repeat(50), 'https://example.test/a.', 'C:\\Users\\a.', 'src/a.ts,', '\ud83d\ude00.', '.\ud83d'];
    for (const text of cases) expect(trimTrailingPunctuation(text), JSON.stringify(text)).toBe(oldTrim(text));
  });

  it('matches the old regex on every short string over a punctuation, word and separator alphabet', () => {
    const alphabet = ['.', ',', ':', 'a', '/', '\n', ' ', ';'];
    let checked = 0;
    const walk = (prefix: string, depth: number): void => {
      expect(trimTrailingPunctuation(prefix), JSON.stringify(prefix)).toBe(oldTrim(prefix));
      checked++;
      if (depth === 0) return;
      for (const token of alphabet) walk(prefix + token, depth - 1);
    };
    walk('', 6);
    expect(checked).toBeGreaterThan(200_000);
  }, 60_000);

  it('matches the old regex on seeded random mixes of punctuation, words, paths and unicode', () => {
    const tokens = ['.', '.', ',', ':', '::', '...', 'a', 'word', '1', '/', '\\', '-', '@', '#', ' ', '\n', '\u00a0', '\u2026', '\ud83d\ude00', 'https://x.test/', 'src/a.ts'];
    let seed = 0x6e32;
    const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
    for (let run = 0; run < 50_000; run++) {
      let text = '';
      for (let count = Math.floor(random() * 30); count > 0; count--) text += tokens[Math.floor(random() * tokens.length)]!;
      expect(trimTrailingPunctuation(text), JSON.stringify(text)).toBe(oldTrim(text));
    }
  }, 60_000);

  it('gives the same index entries as the old trim for punctuation-terminated identifiers', () => {
    const index = buildAnchorIndex([message('see (src/main/a.ts), then src/b.ts: and AIO-42. also #7, C:\\x\\y.ts. https://example.test/a.,')]);
    for (const entry of ['src/main/a.ts', 'src/b.ts', 'AIO-42', '#7', 'https://example.test/a']) expect(index.text).toContain(`- ${entry} (1)`);
    expect(index.text).not.toMatch(/- \S*[.,:] \(/);
  });

  it('indexes a long run of trailing punctuation ending in a word character in linear time', () => {
    const size = 200_000;
    const shapes: Record<string, string> = {
      'dots then word': `${'.'.repeat(size)}a`,
      'colons then word': `${':'.repeat(size)}a`,
      'commas then word': `${','.repeat(size)}a`,
      'word, dots, word': `a${'.'.repeat(size)}b`,
      'path, dots, word': `a/${'.'.repeat(size)}b`,
      'mixed punctuation then word': `${'.:'.repeat(size / 2)}a`,
      'word then dots': `a${'.'.repeat(size)}`,
      'dots and colons only': `${'.:,'.repeat(size / 3)}`,
    };
    for (const [name, content] of Object.entries(shapes)) {
      const started = performance.now();
      buildAnchorIndex([message(content)]);
      expect(performance.now() - started, name).toBeLessThan(1000);
    }
    const started = performance.now();
    expect(trimTrailingPunctuation(`${'.'.repeat(size)}a${':'.repeat(size)}`)).toBe(`${'.'.repeat(size)}a`);
    expect(performance.now() - started).toBeLessThan(1000);
  }, 60_000);

  it('builds the whole continuity package quickly from tool-output-sized text full of punctuation runs', () => {
    const size = 200_000;
    const content = `${'.'.repeat(size)}a`;
    const started = performance.now();
    buildContinuityPackage({ summary: content, recent: [message(content)], messages: [message(content), { ...message(content), type: 'assistant' }],
      contextWindow: 200000, evidence: content, decisions: content,
      stats: { summaryGenerated: false, summarySampledMessages: 0, summaryTotalMessages: 0, skippedRanges: [] }, resumeTurn: { text: content } });
    expect(performance.now() - started).toBeLessThan(2000);
  }, 60_000);
});

describe('prior summary recovery (R6N2 N-2)', () => {
  const stats = { summaryGenerated: true, summarySampledMessages: 1, summaryTotalMessages: 1, skippedRanges: [] };
  const packageWith = (summary: string): string => buildContinuityPackage({ summary, recent: [], messages: [], contextWindow: 10000, stats }).text;
  // The real stored shape (restart-compaction.spec.ts): Harness-sent package, type 'system', internalInput provenance.
  const harnessPackage = (summary: string): OutputMessage => ({ id: 'prior', type: 'system', content: packageWith(summary), timestamp: 1,
    metadata: { internalInput: { actor: 'harness', source: 'compaction-continuity' } } });

  it('reads the summary from a package Harness sent itself', () => {
    expect(latestPriorSummary([message('hello'), harnessPackage('Keep the blue theme')])).toBe('Keep the blue theme');
  });

  it('does not take a continuity package the user pasted for a prior summary', () => {
    const pasted = { ...message(packageWith('Pasted instructions the user typed')), id: 'pasted' };
    expect(latestPriorSummary([pasted])).toBeNull();
    expect(latestPriorSummary([{ ...pasted, type: 'assistant' }])).toBeNull();
    // A newer pasted package must not displace the real, earlier one.
    expect(latestPriorSummary([harnessPackage('Real prior state'), pasted])).toBe('Real prior state');
  });
});
