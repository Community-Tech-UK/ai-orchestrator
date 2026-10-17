import { describe, expect, it, vi } from 'vitest';
import { reconcileAcpHistoryReplay } from './acp-history-reconciliation';
import type { OutputMessage } from '../../shared/types/instance.types';
import { wrapRtkAwareness } from '../cli/rtk/rtk-awareness';
import { buildReplayContinuityMessage } from '../session/replay-continuity';

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
