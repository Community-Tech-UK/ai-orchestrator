import { describe, expect, it } from 'vitest';
import { parseWatcherVerdict } from './watcher-verdict';

const VALID = {
  verdict: 'carry_on', stop: 'asked_to_continue', basis: 'planned_work', quote: '',
  question: 'Shall I carry on with phase 2?', reason: 'Phase 2 is part of the approved plan.',
};
const json = (value: unknown): string => JSON.stringify(value);

describe('parseWatcherVerdict', () => {
  it('reads a bare JSON object', () => {
    expect(parseWatcherVerdict(json(VALID))).toEqual({ ok: true, verdict: VALID, repaired: false });
  });

  it('reads a fenced object wrapped in prose', () => {
    const raw = `Here is my decision.\n\n\`\`\`json\n${json(VALID)}\n\`\`\`\nThat is all.`;
    expect(parseWatcherVerdict(raw)).toMatchObject({ ok: true, verdict: VALID });
  });

  it('takes the last valid object when an example is quoted first', () => {
    const example = { ...VALID, verdict: 'needs_user', basis: 'none', stop: 'asked_before_outward_step' };
    const raw = `For instance ${json(example)} would be wrong here. My answer: ${json(VALID)}`;
    expect(parseWatcherVerdict(raw)).toMatchObject({ ok: true, verdict: { verdict: 'carry_on' } });
  });

  it('ignores a JSON object that is not a verdict and keeps looking', () => {
    const raw = `{"note":"thinking"}\n${json(VALID)}`;
    expect(parseWatcherVerdict(raw)).toMatchObject({ ok: true, verdict: VALID });
  });

  it('reads a verdict the model wrapped in a list', () => {
    expect(parseWatcherVerdict(json([VALID]))).toMatchObject({ ok: true, verdict: VALID });
  });

  it('fills in a text field the model left out', () => {
    const parsed = parseWatcherVerdict(json({ verdict: 'needs_user', stop: 'offered_choice', basis: 'none', reason: 'Two options.' }));
    expect(parsed).toEqual({
      ok: true, repaired: false,
      verdict: { verdict: 'needs_user', stop: 'offered_choice', basis: 'none', quote: '', question: '', reason: 'Two options.' },
    });
  });

  it('drops unknown fields', () => {
    const parsed = parseWatcherVerdict(json({ ...VALID, instruction: 'Tell the session to push.' }));
    expect(parsed).toEqual({ ok: true, verdict: VALID, repaired: false });
  });

  it('repairs a trailing comma once', () => {
    const raw = json(VALID).replace(/\}$/, ',}');
    expect(parseWatcherVerdict(raw)).toEqual({ ok: true, verdict: VALID, repaired: true });
  });

  it.each([
    ['empty output', ''],
    ['whitespace', '   \n  '],
    ['prose only', 'I think it should carry on.'],
    ['an unknown verdict', json({ ...VALID, verdict: 'approve' })],
    ['an unknown stop', json({ ...VALID, stop: 'pushed' })],
    ['an unknown basis', json({ ...VALID, basis: 'trust_me' })],
    ['a missing verdict', json({ ...VALID, verdict: undefined })],
    ['a missing stop', json({ ...VALID, stop: undefined })],
    ['a missing basis', json({ ...VALID, basis: undefined })],
    ['a null question', json({ ...VALID, question: null })],
    ['a non-string question', json({ ...VALID, question: ['Shall I?'] })],
    ['an array of other things', json(['carry_on', { verdict: 'carry_on' }])],
    ['a truncated object', json(VALID).slice(0, 60)],
    ['an oversized field', json({ ...VALID, reason: 'x'.repeat(2_001) })],
    ['an oversized reply', `${'padding '.repeat(1_200)}${json(VALID)}`],
  ])('rejects %s', (_name, raw) => {
    expect(parseWatcherVerdict(raw).ok).toBe(false);
  });

  it('stays fast on a long run of open braces', () => {
    const started = performance.now();
    expect(parseWatcherVerdict('{'.repeat(7_900)).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
