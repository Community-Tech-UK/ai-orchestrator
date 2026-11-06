import { describe, expect, it } from 'vitest';
import { RECALL_EVIDENCE_MAX_AGE_DAYS, buildRecallEvidence, evaluateRecallEvidence, renderEvidenceModule, summariseRecall, tallyVerdicts } from './recall-evidence';
import { recallScore, type RecallChatResult, type RecallEvidence, type RecallTally } from './recall-types';

const NOW = new Date('2026-11-01T00:00:00Z');
const tally = (correct: number, partial = 0, wrong = 0, unknown = 0): RecallTally => ({ correct, partial, wrong, unknown });
const chat = (before: RecallTally, after: RecallTally, over: Partial<RecallChatResult> = {}): RecallChatResult => ({
  chatKey: 'k0', conversationKey: 'c0', contextTokensAtCut: 290_000, humanPrompts: 40, questionCount: 12, before, after,
  compaction: { boundaries: 1, preTokens: 292_000, postTokens: 20_000 }, costUsd: 1.2, ...over,
});
const evidence = (chats: RecallChatResult[], over: Partial<RecallEvidence> = {}): RecallEvidence => ({
  schema: 1, generatedAt: '2026-10-25T12:00:00Z', method: 'cli-replay', model: 'claude-sonnet-5-5', targetTokens: 300_000, chats, ...over,
});
/** Three different conversations, each with its own key. */
const three = (before: RecallTally, after: RecallTally): RecallChatResult[] =>
  [0, 1, 2].map(index => chat(before, after, { chatKey: `k${index}`, conversationKey: `c${index}` }));

describe('tallies and scores', () => {
  it('counts verdicts and scores a partial answer as half', () => {
    expect(tallyVerdicts(['correct', 'partial', 'wrong', 'unknown', 'correct'])).toEqual(tally(2, 1, 1, 1));
    expect(recallScore(tally(8, 2, 1, 1))).toBeCloseTo(9 / 12, 6);
    expect(recallScore(tally(0, 0, 0, 0))).toBe(0);
  });
});

describe('evaluateRecallEvidence', () => {
  it('is eligible when recall after the summary is as good as before', () => {
    const result = evaluateRecallEvidence(evidence(three(tally(10, 1, 1), tally(10, 1, 1))), NOW);
    expect(result).toMatchObject({ eligible: true });
    expect(summariseRecall(evidence(three(tally(10, 1, 1), tally(9, 1, 2))))).toMatchObject({ chats: 3, questions: 36 });
  });

  it('allows a small pooled drop (10 points) and refuses a larger one', () => {
    expect(evaluateRecallEvidence(evidence(three(tally(10, 0, 2), tally(9, 0, 3))), NOW)).toMatchObject({ eligible: true });
    expect(evaluateRecallEvidence(evidence(three(tally(10, 0, 2), tally(8, 0, 4))), NOW)).toMatchObject({ eligible: false, reason: 'recall-worse' });
  });

  it('refuses when any single chat loses more than 25 points even if the pool looks fine', () => {
    const chats = [chat(tally(10, 0, 2), tally(12, 0, 0), { chatKey: 'k0', conversationKey: 'c0' }), chat(tally(10, 0, 2), tally(12, 0, 0), { chatKey: 'k1', conversationKey: 'c1' }), chat(tally(12, 0, 0), tally(8, 0, 4), { chatKey: 'k2', conversationKey: 'c2' })];
    expect(evaluateRecallEvidence(evidence(chats), NOW)).toMatchObject({ eligible: false, reason: 'recall-worse' });
  });

  it('refuses when the model could not answer well even with the full chat, because then the test shows nothing', () => {
    expect(evaluateRecallEvidence(evidence(three(tally(4, 0, 8), tally(4, 0, 8))), NOW)).toMatchObject({ eligible: false, reason: 'baseline-too-low' });
  });

  it('needs three chats of at least ten questions each', () => {
    expect(evaluateRecallEvidence(evidence(three(tally(10, 1, 1), tally(10, 1, 1)).slice(0, 2)), NOW)).toMatchObject({ eligible: false, reason: 'too-few-chats' });
    const short = three(tally(9, 0, 0), tally(9, 0, 0)).map(item => ({ ...item, questionCount: 9 }));
    expect(evaluateRecallEvidence(evidence(short), NOW)).toMatchObject({ eligible: false, reason: 'too-few-questions' });
  });

  it('needs proof that each chat really was summarised down from near 300K', () => {
    const none = three(tally(10, 1, 1), tally(10, 1, 1)).map((item, index) => (index === 0 ? { ...item, compaction: { boundaries: 0, preTokens: null, postTokens: null } } : item));
    expect(evaluateRecallEvidence(evidence(none), NOW)).toMatchObject({ eligible: false, reason: 'no-compaction' });
    const grew = three(tally(10, 1, 1), tally(10, 1, 1)).map(item => ({ ...item, compaction: { boundaries: 1, preTokens: 290_000, postTokens: 300_000 } }));
    expect(evaluateRecallEvidence(evidence(grew), NOW)).toMatchObject({ eligible: false, reason: 'no-compaction' });
    const small = three(tally(10, 1, 1), tally(10, 1, 1)).map(item => ({ ...item, contextTokensAtCut: 120_000, compaction: { boundaries: 1, preTokens: 122_000, postTokens: 15_000 } }));
    expect(evaluateRecallEvidence(evidence(small), NOW)).toMatchObject({ eligible: false, reason: 'wrong-size' });
  });

  it('expires after the quarterly window and for a different ceiling than the one being set', () => {
    expect(RECALL_EVIDENCE_MAX_AGE_DAYS).toBe(120);
    const old = evidence(three(tally(10, 1, 1), tally(10, 1, 1)), { generatedAt: '2026-05-01T00:00:00Z' });
    expect(evaluateRecallEvidence(old, NOW)).toMatchObject({ eligible: false, reason: 'stale' });
    const other = evidence(three(tally(10, 1, 1), tally(10, 1, 1)), { targetTokens: 500_000 });
    expect(evaluateRecallEvidence(other, NOW)).toMatchObject({ eligible: false, reason: 'wrong-size' });
  });

  it('treats missing or malformed evidence as not eligible and never throws', () => {
    expect(evaluateRecallEvidence(null, NOW)).toMatchObject({ eligible: false, reason: 'no-evidence' });
    expect(evaluateRecallEvidence(undefined, NOW)).toMatchObject({ eligible: false, reason: 'no-evidence' });
    for (const bad of [{}, { schema: 2 }, { schema: 1, chats: 'x' }, { ...evidence([]), generatedAt: 'not a date' }, 42, 'text']) {
      expect(evaluateRecallEvidence(bad, NOW)).toMatchObject({ eligible: false });
    }
  });

  it('builds a record the rule accepts, and renders a module that holds counts only', () => {
    const built = buildRecallEvidence(three(tally(10, 1, 1), tally(10, 1, 1)), 'claude-sonnet-5-5', 300_000, NOW);
    expect(built).toMatchObject({ schema: 1, method: 'cli-replay', generatedAt: '2026-11-01T00:00:00.000Z', model: 'claude-sonnet-5-5' });
    expect(evaluateRecallEvidence(built, NOW)).toMatchObject({ eligible: true });
    const source = renderEvidenceModule(built);
    expect(source).toContain('export const OWN_CHAT_CEILING_RECALL_EVIDENCE: RecallEvidence | null =');
    expect(source).toContain('"chatKey": "k0"');
    expect(Object.keys(JSON.parse(source.slice(source.indexOf('= {') + 2, source.lastIndexOf(';'))))).toEqual(['schema', 'generatedAt', 'method', 'model', 'targetTokens', 'chats']);
  });

  it('refuses evidence whose numbers cannot be trusted, so a malformed record can never open the gate', () => {
    const good = (): RecallChatResult[] => three(tally(10, 1, 1), tally(10, 1, 1));
    const withChat = (change: (item: RecallChatResult) => void): RecallEvidence => { const chats = good(); change(chats[0]); return evidence(chats); };
    const bad: Array<[string, RecallEvidence]> = [
      ['no post size', withChat(item => { (item.compaction as { postTokens?: number }).postTokens = undefined; })],
      ['no boundary count', withChat(item => { (item.compaction as { boundaries?: number }).boundaries = undefined; })],
      ['fractional boundaries', withChat(item => { item.compaction.boundaries = 1.5; })],
      ['NaN pre size', withChat(item => { item.compaction.preTokens = Number.NaN; })],
      ['negative post size', withChat(item => { item.compaction.postTokens = -5; })],
      ['pre size unrelated to the cut', withChat(item => { item.compaction.preTokens = 100_000; })],
      ['NaN cut size', withChat(item => { item.contextTokensAtCut = Number.NaN; })],
      ['too few typed prompts', withChat(item => { item.humanPrompts = 5; })],
      ['fractional prompts', withChat(item => { item.humanPrompts = 40.5; })],
      ['negative cost', withChat(item => { item.costUsd = -1; })],
      ['empty chat key', withChat(item => { item.chatKey = ''; })],
      ['empty conversation key', withChat(item => { item.conversationKey = ''; })],
      ['fractional tally', withChat(item => { item.before.correct = 10.5; })],
      ['negative tally', withChat(item => { item.after.wrong = -1; })],
      ['same chat key twice', evidence([chat(tally(10, 1, 1), tally(10, 1, 1), { chatKey: 'k0', conversationKey: 'c0' }), chat(tally(10, 1, 1), tally(10, 1, 1), { chatKey: 'k0', conversationKey: 'c1' }), chat(tally(10, 1, 1), tally(10, 1, 1), { chatKey: 'k2', conversationKey: 'c2' })])],
      ['one conversation copied three times', evidence([0, 1, 2].map(index => chat(tally(10, 1, 1), tally(10, 1, 1), { chatKey: `k${index}`, conversationKey: 'same' })))],
      ['wrong method', evidence(good(), { method: 'synthetic' as never })],
      ['empty model', evidence(good(), { model: '' })],
      ['model not a string', evidence(good(), { model: 7 as never })],
      ['dated in the future', evidence(good(), { generatedAt: '2026-11-02T00:00:00Z' })],
      ['target not finite', evidence(good(), { targetTokens: Number.NaN })],
    ];
    for (const [name, record] of bad) expect(evaluateRecallEvidence(record, NOW), name).toMatchObject({ eligible: false, reason: 'malformed' });
    expect(evaluateRecallEvidence(evidence(good()), NOW)).toMatchObject({ eligible: true });
  });

  it('never lets a run with custom summarising instructions open the gate, because the app does not send them', () => {
    const variant = buildRecallEvidence(three(tally(10, 1, 1), tally(10, 1, 1)), 'claude-sonnet-5-5', 300_000, NOW, 'cli-replay-custom-compact');
    expect(variant.method).toBe('cli-replay-custom-compact');
    expect(evaluateRecallEvidence(variant, NOW)).toMatchObject({ eligible: false, reason: 'malformed' });
    expect(evaluateRecallEvidence(buildRecallEvidence(three(tally(10, 1, 1), tally(10, 1, 1)), 'claude-sonnet-5-5', 300_000, NOW), NOW)).toMatchObject({ eligible: true });
  });

  it('allows a few minutes of clock difference but not a future date', () => {
    expect(evaluateRecallEvidence(evidence(three(tally(10, 1, 1), tally(10, 1, 1)), { generatedAt: '2026-11-01T00:03:00Z' }), NOW)).toMatchObject({ eligible: true });
  });

  it('rejects counts that do not add up to the stated question count', () => {
    const lying = three(tally(10, 1, 1), tally(10, 1, 1)).map(item => ({ ...item, questionCount: 15 }));
    expect(evaluateRecallEvidence(evidence(lying), NOW)).toMatchObject({ eligible: false, reason: 'malformed' });
  });
});
