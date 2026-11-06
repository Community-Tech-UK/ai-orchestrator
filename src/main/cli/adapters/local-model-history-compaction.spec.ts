import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SYSTEM_PROMPT } from '../../context/context-compaction-prompt';
const helper = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../../rlm/auxiliary-llm-service', () => ({ getAuxiliaryLlmService: () => ({ generate: helper.generate }) }));
vi.mock('../../rlm/llm-service', () => ({ getLLMService: () => ({ isAvailable: async () => true, generate: vi.fn() }) }));
vi.mock('../../core/system/model-call-recorder', () => ({ recordModelCall: vi.fn() }));
import { CONTINUITY_MARKER, CONTINUITY_WAIT_RULE } from '../../context/compaction-continuity';
import { compactLocalHistory, estimateHistoryTokens, type LocalModelHistoryTurn } from './local-model-history-compaction';

describe('compactLocalHistory', () => {
  beforeEach(() => { helper.generate.mockReset().mockRejectedValue(new Error('Fixture helper unavailable')); });

  it('uses the real isolated compactor with the complete request and preserve-input option by default', async () => {
    helper.generate.mockResolvedValue({ text: 'Keep backward compatibility and verify src/parser.ts.',
      decision: { source: 'local', allowFrontierFallback: false } });
    const history: LocalModelHistoryTurn[] = [
      { role: 'system', content: 'Keep replies concise.' },
      { role: 'user', content: 'Fix src/parser.ts. ' + 'Earlier detail. '.repeat(6000) },
      { role: 'assistant', content: 'Investigating. ' + 'Earlier result. '.repeat(6000) },
      { role: 'user', content: 'Then verify the change.' },
    ];
    const result = await compactLocalHistory(history, { windowTokens: 8000 });
    expect(result).not.toBeNull();
    expect(helper.generate).toHaveBeenCalledWith('compression', COMPACTION_SYSTEM_PROMPT,
      expect.stringContaining('src/parser.ts'), { preserveInput: true });
    expect(result!.history[1]!.content).toContain('Keep backward compatibility');
    expect(estimateHistoryTokens(result!.history)).toBeLessThanOrEqual(8000);
    expect(result!.history.at(-1)).toEqual(history.at(-1));
  });

  it('Step 7 item 5: tells the compression helper a manual compaction is user-initiated, and an automatic one is not', async () => {
    helper.generate.mockResolvedValue({ text: 'Keep backward compatibility.',
      decision: { source: 'local', allowFrontierFallback: false } });
    const history: LocalModelHistoryTurn[] = [
      { role: 'user', content: 'Fix src/parser.ts. ' + 'Earlier detail. '.repeat(6000) },
      { role: 'assistant', content: 'Investigating. ' + 'Earlier result. '.repeat(6000) },
      { role: 'user', content: 'Then verify the change.' },
    ];

    await compactLocalHistory(history, { windowTokens: 8000, userInitiated: true });
    expect(helper.generate.mock.calls[0]![3]).toEqual({ preserveInput: true, userInitiated: true });

    helper.generate.mockClear();
    await compactLocalHistory(history, { windowTokens: 8000 });
    expect(helper.generate.mock.calls[0]![3]).toEqual({ preserveInput: true });
  });

  it('keeps a genuine user request containing the continuity marker in user reference data', async () => {
    const ask = `Fix the parser for ${CONTINUITY_MARKER}. Keep this request.`;
    const result = await compactLocalHistory([
      { role: 'user', content: ask },
      { role: 'assistant', content: 'Older result. '.repeat(9000) },
      { role: 'user', content: 'Please finish.' },
    ], { windowTokens: 8000, summarise: () => 'Parser task remains open.' });
    expect(result).not.toBeNull();
    const users = result!.history[0]!.content.split('<user_messages>')[1]!.split('</user_messages>')[0]!;
    expect(users).toContain(ask);
  });

  it('refuses a replacement that would still overflow the local model window', async () => {
    const history: LocalModelHistoryTurn[] = [
      { role: 'user', content: 'Old request. '.repeat(20_000) },
      { role: 'assistant', content: 'Old reply. '.repeat(20_000) },
      { role: 'user', content: 'Finish.' },
    ];
    const before = history.map(turn => ({ ...turn }));
    expect(await compactLocalHistory(history, { windowTokens: 8000, summarise: () => 'x'.repeat(40_000) })).toBeNull();
    expect(history).toEqual(before);
  });
  it('preserves the latest user request and system message while replacing older turns with a continuity package', async () => {
    const history: LocalModelHistoryTurn[] = [
      { role: 'system', content: 'Use the local model safely.' },
      { role: 'user', content: `Implement the import path. ${'Earlier input. '.repeat(1500)}` },
      { role: 'assistant', content: `I will change the parser. ${'Earlier output. '.repeat(1500)}` },
      { role: 'user', content: 'Please verify the import path.' },
    ];
    const result = await compactLocalHistory(history, { windowTokens: 1200, summarise: () => 'Parser updated; verification pending.' });

    expect(result).not.toBeNull();
    expect(result!.history[0]).toEqual(history[0]);
    expect(result!.history.at(-1)).toEqual(history.at(-1));
    expect(result!.history[1]!.content).toContain(CONTINUITY_MARKER);
    expect(result!.history[1]!.content).toContain(CONTINUITY_WAIT_RULE);
    expect(result!.history[1]!.content).toContain('Parser updated; verification pending.');
    expect(result!.stats.summarised).toBeGreaterThan(0);
    expect(estimateHistoryTokens(result!.history)).toBeLessThan(estimateHistoryTokens(history));
  });

  it('leaves a single user message untouched', async () => {
    const history: LocalModelHistoryTurn[] = [{ role: 'user', content: 'Keep this request.' }];
    expect(await compactLocalHistory(history, { windowTokens: 1200 })).toBeNull();
    expect(history).toEqual([{ role: 'user', content: 'Keep this request.' }]);
  });

  it('carries the prior summary into a second local compaction', async () => {
    const first = await compactLocalHistory([
      { role: 'user', content: `Original task. ${'Long old message. '.repeat(1800)}` },
      { role: 'assistant', content: `Initial work. ${'Long old result. '.repeat(1800)}` },
      { role: 'user', content: 'Continue the original task.' },
    ], { windowTokens: 1200, summarise: () => 'Original decision: keep the import path.' });
    expect(first).not.toBeNull();

    const second = await compactLocalHistory([
      ...first!.history,
      { role: 'assistant', content: `More work. ${'Long second result. '.repeat(2000)}` },
      { role: 'user', content: 'Finish and verify.' },
    ], { windowTokens: 1200 });

    expect(second).not.toBeNull();
    expect(second!.history.find(turn => turn.content.includes(CONTINUITY_MARKER))?.content)
      .toContain('Original decision: keep the import path.');
    expect(second!.history.at(-1)?.content).toBe('Finish and verify.');
  });
});
