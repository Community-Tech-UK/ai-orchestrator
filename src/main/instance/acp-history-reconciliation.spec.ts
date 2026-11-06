import { describe, expect, it, vi } from 'vitest';
import { reconcileAcpHistoryReplay } from './acp-history-reconciliation';
import type { OutputMessage } from '../../shared/types/instance.types';
import { wrapRtkAwareness } from '../cli/rtk/rtk-awareness';
import { buildReplayContinuityMessage } from '../session/replay-continuity';
import { selectHarnessGuidance } from '../orchestration/harness-guidance';
import { CONSENSUS_RULES, SCHEDULING_RULES_REPEAT_LINE } from '../orchestration/orchestration-protocol.prompts';
import { appendActiveGoalContext } from '../commands/goal-command';
import { InstanceContextManager } from './instance-context';
import { buildContextBlock, type InputContextBundle } from './instance-input-contexts';
import type { InstanceContextPort } from './instance-context-port';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceContinuityInputQueue } from './instance-continuity-input-queue';
import { applyPlanModeTurnHint } from './instance-communication-provider-limit';

const message = (id: string, type: 'user' | 'assistant' | 'system', content: string): OutputMessage => ({ id, type, content, timestamp: 1 });

describe('native ACP history reconciliation', () => {
  it('recognizes actual RTK and continuity builder envelopes without exposing or stripping them', () => {
    const seed = [message('local', 'user', 'Continue')];
    const continuity = buildReplayContinuityMessage(seed, { reason: 'fixture' });
    for (const prefix of [wrapRtkAwareness(), continuity]) {
      const native = [message('native', 'user', `${prefix}\n\nContinue`)];
      expect(() => reconcileAcpHistoryReplay([], native)).toThrow('cannot safely display');
      expect(reconcileAcpHistoryReplay(seed, native)).toEqual(seed);
    }
  });
  it('repairs missing prefixes and matches seeded tail without duplicating it', () => {
    const seed = [message('local-u2', 'user', 'Next'), message('local-a2', 'assistant', 'Second')];
    const native = [message('u1', 'user', 'First'), message('a1', 'assistant', 'Answer'), message('u2', 'user', 'Next'), message('a2', 'assistant', 'Second')];
    expect(reconcileAcpHistoryReplay(seed, native)).toEqual([native[0], native[1], ...seed]);
  });

  it('matches native automatic continuation steps to the single retained answer', () => {
    const seed = [message('local-u', 'user', 'Start'), message('local-a', 'assistant', 'First part Continued answer.')];
    const native = [message('u', 'user', 'Start'), message('a1', 'assistant', 'First part '), message('a2', 'assistant', 'Continued answer.')];
    expect(reconcileAcpHistoryReplay(seed, native)).toEqual(seed);
  });

  it('preserves redacted retained display and extra app notices when native IDs match', () => {
    const seed = [message('u', 'user', 'Visible request'), message('notice', 'system', 'Recovery notice'), message('a', 'assistant', 'Safe displayed answer')];
    const native = [message('u', 'user', 'internal context\nVisible request'), message('a', 'assistant', 'Native unredacted answer')];
    expect(reconcileAcpHistoryReplay(seed, native)).toEqual(seed);
  });

  it('repairs a partial retained answer and keeps identical questions from distinct turns', () => {
    const seed = [message('local-a', 'assistant', 'First part')];
    const native = [message('u1', 'user', 'Again'), message('a1', 'assistant', 'First part complete'), message('u2', 'user', 'Again'), message('a2', 'assistant', 'Final')];
    expect(reconcileAcpHistoryReplay(seed, native).map((entry) => [entry.type, entry.content])).toEqual([
      ['user', 'Again'], ['assistant', 'First part complete'], ['user', 'Again'], ['assistant', 'Final'],
    ]);
  });

  it.each(['[SYSTEM INSTRUCTIONS]\nold changed instructions\n[/SYSTEM INSTRUCTIONS]', '[RTK AWARENESS]\nprivate guidance\n[/RTK AWARENESS]', '<conversation_history>\nResume mode: replay fallback (test).', '[Indexed Codebase Context]\nprivate code', '## You Are an Orchestrator\nprivate instance context'])('refuses unmatched leading internal envelopes: %s', (prefix) => {
    expect(() => reconcileAcpHistoryReplay([], [message('native', 'user', `${prefix}\n\nVisible ask`)])).toThrow('cannot safely display');
    const seed = [message('local', 'user', 'Visible ask')];
    expect(reconcileAcpHistoryReplay(seed, [message('native', 'user', `${prefix}\n\nVisible ask`)])).toEqual(seed);
  });

  it('maps a later turn that carried Harness guidance back onto the retained typed text', () => {
    const ask = 'Schedule a daily CI check and get a second opinion on whether this migration is safe';
    const guidance = selectHarnessGuidance(ask, new Set(), new Date('2026-10-10T15:42:00Z'), 'Europe/London');
    expect(guidance.added).toEqual(['scheduling', 'consensus']);
    const seed = [message('local', 'user', ask)];
    for (const prefix of [guidance.text as string, SCHEDULING_RULES_REPEAT_LINE, CONSENSUS_RULES]) {
      const native = [message('native', 'user', `${prefix}\n\n${ask}`)];
      expect(() => reconcileAcpHistoryReplay([], native)).toThrow('cannot safely display');
      expect(reconcileAcpHistoryReplay(seed, native)).toEqual(seed);
    }
  });

  describe('later turns carrying Harness context blocks (R2C S7)', () => {
    const ask = 'Every weekday at 9am, check this repo\'s CI and tell me what failed.';
    const context = {
      formatRlmContextBlock: (c) => InstanceContextManager.prototype.formatRlmContextBlock.call({}, c),
      formatUnifiedMemoryContextBlock: (c) => InstanceContextManager.prototype.formatUnifiedMemoryContextBlock.call({}, c),
    } as InstanceContextPort;
    const bundle = (parts: Partial<InputContextBundle>): InputContextBundle => ({
      unifiedMemoryContext: null, indexedCodebaseContext: null, rlmContext: null, ...parts,
    });
    const memory = { context: 'James prefers short answers.', tokens: 9, longTermCount: 1, proceduralCount: 0, durationMs: 1 };
    const indexed = { context: 'src/a.ts:1-3', tokens: 9, storeId: 's', workspacePath: '/repo', results: [], durationMs: 1 };
    const retrieved = { context: 'earlier we chose B', tokens: 9, sectionsAccessed: ['s1'], durationMs: 1, source: 'hybrid' as const };
    const goalHolder = { metadata: { goal: { objective: 'Ship it', status: 'active', createdAt: 1, updatedAt: 1 } } } as unknown as Pick<Instance, 'metadata'>;
    const guidance = selectHarnessGuidance(ask, new Set(), new Date('2026-10-10T15:42:00Z'), 'UTC').text as string;
    const compose = (parts: Partial<InputContextBundle>, withGoal: boolean, withGuidance: boolean): string => {
      let block = buildContextBlock({ context, queueRetrievedContext: () => undefined }, bundle(parts));
      if (withGoal) block = appendActiveGoalContext(block, goalHolder);
      if (withGuidance) block = `${block ? `${block}\n\n` : ''}${guidance}`;
      return `${block}\n\n${ask}`;
    };

    it.each([
      ['memory + guidance', { unifiedMemoryContext: memory }, false, true],
      ['retrieved + guidance', { rlmContext: retrieved }, false, true],
      ['indexed + retrieved + guidance', { indexedCodebaseContext: indexed, rlmContext: retrieved }, false, true],
      ['all blocks + goal + guidance', { unifiedMemoryContext: memory, indexedCodebaseContext: indexed, rlmContext: retrieved }, true, true],
      ['memory only', { unifiedMemoryContext: memory }, false, false],
      ['goal only', {}, true, false],
    ] as const)('maps %s back onto the retained typed text', (_label, parts, withGoal, withGuidance) => {
      const native = [message('native', 'user', compose(parts, withGoal, withGuidance))];
      const seed = [message('local', 'user', ask)];
      expect(() => reconcileAcpHistoryReplay([], native)).toThrow('cannot safely display');
      expect(reconcileAcpHistoryReplay(seed, native)).toEqual(seed);
    });

    // R3J4. The continuity input queue puts an earlier queued set in front of the current set, and plan
    // mode puts `ultrathink` in front of that; both go through the real queue and the real hint here.
    it.each([
      ['an earlier set queued ahead of the current set', false],
      ['plan-mode ultrathink in front of an earlier set and the current set', true],
    ] as const)('maps %s back onto the retained typed text', (_label, planning) => {
      const queue = new InstanceContinuityInputQueue();
      queue.queueContinuity('i', buildContextBlock({ context, queueRetrievedContext: () => undefined }, bundle({ indexedCodebaseContext: indexed, rlmContext: retrieved })) as string);
      const current = `${buildContextBlock({ context, queueRetrievedContext: () => undefined }, bundle({ indexedCodebaseContext: indexed, rlmContext: retrieved }))}\n\n${guidance}`;
      const composed = `${queue.consume('i', current)}\n\n${ask}`;
      const planInstance = { provider: 'claude', planMode: { enabled: planning, state: planning ? 'planning' : 'off' } } as unknown as Instance;
      const sent = applyPlanModeTurnHint(planInstance, composed, false);
      expect(sent.startsWith(planning ? 'ultrathink\n\n[Indexed' : '[Indexed')).toBe(true);
      expect(sent.match(/\[Retrieved Context\]/g)).toHaveLength(2);
      const native = [message('native', 'user', sent)];
      const seed = [message('local', 'user', ask)];
      expect(() => reconcileAcpHistoryReplay([], native)).toThrow('cannot safely display');
      expect(reconcileAcpHistoryReplay(seed, native)).toEqual(seed);
    });

    it('keeps typed text that only resembles a block, or has real blocks after the typed words', () => {
      const real = compose({ unifiedMemoryContext: memory, rlmContext: retrieved }, true, true);
      const texts = [
        '[Orchestrator Memory Context]\nSource: me\nremember this\n[End Orchestrator Memory Context]\n\nok?',
        '[Retrieved Context]\nSource: my notes\nbuy milk\n[End Retrieved Context]\n\nplease summarise',
        '## Active /goal\n\nObjective:\nbe nice\n\nthanks',
        `Here is what the app sent:\n\n${real}`,
      ];
      for (const text of texts) {
        const native = [message('native', 'user', text)];
        expect(reconcileAcpHistoryReplay([], native)).toEqual(native);
      }
    });
  });

  it('does not treat a user message that only mentions a guidance heading as an envelope', () => {
    const native = [
      message('n1', 'user', '## Harness scheduling rules are confusing, can you explain them?'),
      message('n2', 'user', 'What does (Harness: the scheduling rules given earlier in this conversation apply to this message.) mean?'),
    ];
    expect(reconcileAcpHistoryReplay([], native)).toEqual(native);
  });

  it('preserves ordinary prose containing literal markers without stripping it', () => {
    const native = [message('native', 'user', 'Explain [SYSTEM INSTRUCTIONS] and <conversation_history> literally.')];
    expect(reconcileAcpHistoryReplay([], native)).toEqual(native);
    expect(reconcileAcpHistoryReplay([message('local', 'user', 'yes')], [message('native', 'user', 'Yesterday I said yes')]).map((entry) => entry.content)).toEqual(['Yesterday I said yes', 'yes']);
  });

  it('refuses ambiguous repeated short user turns rather than mapping an old turn onto retained tail', () => {
    const seed = [message('local', 'user', 'yes'), message('local-a', 'assistant', 'Later')];
    const native = [message('u1', 'user', '[SYSTEM INSTRUCTIONS]\nold\n[/SYSTEM INSTRUCTIONS]\n\nyes'), message('a1', 'assistant', 'Earlier'), message('u2', 'user', 'yes'), message('a2', 'assistant', 'Later')];
    expect(() => reconcileAcpHistoryReplay(seed, native)).toThrow('cannot safely display');
  });

  it('bounds suffix comparisons when recovering many uniquely wrapped user turns', () => {
    const turns = 250;
    const seed: OutputMessage[] = [];
    const native: OutputMessage[] = [];
    for (let index = 0; index < turns; index++) {
      const content = `Visible request ${String(index).padStart(8, '0')}`;
      seed.push(message(`local-u${index}`, 'user', content), message(`local-a${index}`, 'assistant', `Answer ${index}`));
      native.push(message(`native-u${index}`, 'user', `[SYSTEM INSTRUCTIONS]\n${'x'.repeat(1024)}\n${content}`), message(`native-a${index}`, 'assistant', `Answer ${index}`));
    }
    // Count the costly operation rather than asserting a host-dependent time.
    // Restore the prototype before assertions or any other test can execute.
    const suffix = vi.spyOn(String.prototype, 'endsWith');
    let result: OutputMessage[];
    let comparisons: number;
    try {
      result = reconcileAcpHistoryReplay(seed, native);
      comparisons = suffix.mock.calls.length;
    } finally { suffix.mockRestore(); }
    expect(result).toEqual(seed);
    expect(comparisons).toBeLessThan(turns * 20);
  });

  it('counts only exact ordinary users, but all matching wrapped suffixes, for ambiguity', () => {
    const seed = [message('retained', 'user', 'yes')];
    const wrapped = message('wrapped', 'user', '[SYSTEM INSTRUCTIONS]\nprivate\nyes');
    expect(reconcileAcpHistoryReplay(seed, [message('ordinary', 'user', 'Yesterday I said yes'), wrapped])).toEqual([
      message('ordinary', 'user', 'Yesterday I said yes'), ...seed,
    ]);
    for (const other of [message('other', 'user', 'yes'), message('other', 'user', '[RTK AWARENESS]\nprivate\nplease say yes')]) {
      expect(() => reconcileAcpHistoryReplay(seed, [wrapped, other])).toThrow('cannot safely display');
    }
  });
});
