import { describe, it, expect } from 'vitest';
import { LessonStore, normalizeLessonText } from './lesson-store';

describe('normalizeLessonText', () => {
  it('lowercases, collapses whitespace, trims', () => {
    expect(normalizeLessonText('  Always   Run\nTests  ')).toBe('always run tests');
  });
});

describe('LessonStore', () => {
  it('captures a new active lesson with one reinforcement', () => {
    const s = new LessonStore();
    const { lesson, reinforced } = s.capture('Always run the typecheck after edits', 100);
    expect(reinforced).toBe(false);
    expect(lesson).toMatchObject({ reinforcements: 1, status: 'active' });
    expect(lesson.createdAt).toBe(100);
  });

  it('reinforces (does not duplicate) an equivalent lesson', () => {
    const s = new LessonStore();
    s.capture('Always run the typecheck', 0);
    const second = s.capture('  always   RUN the Typecheck ', 50); // same after normalization
    expect(second.reinforced).toBe(true);
    expect(second.lesson.reinforcements).toBe(2);
    expect(second.lesson.updatedAt).toBe(50);
    expect(s.active()).toHaveLength(1);
  });

  it('treats distinct lessons separately', () => {
    const s = new LessonStore();
    s.capture('Run tests', 0);
    s.capture('Lint before commit', 0);
    expect(s.active()).toHaveLength(2);
  });

  it('throws on empty lesson text', () => {
    const s = new LessonStore();
    expect(() => s.capture('   ', 0)).toThrow(/empty lesson/);
  });

  it('supersede deprecates the old lesson and links + inherits reinforcement', () => {
    const s = new LessonStore();
    const { lesson: old } = s.capture('Use var for config', 0);
    s.capture('Use var for config', 1); // reinforce → 2
    const next = s.supersede(old.id, 'Use const for config', 10);
    expect(next.supersedes).toBe(old.id);
    expect(next.reinforcements).toBe(3); // 2 + 1
    expect(s.get(old.id)?.status).toBe('deprecated');
    expect(s.active().map((l) => l.text)).toEqual(['Use const for config']);
  });

  it('a deprecated lesson no longer reinforces — recapture creates a fresh active one', () => {
    const s = new LessonStore();
    const { lesson } = s.capture('Flaky thing', 0);
    s.deprecate(lesson.id);
    const again = s.capture('Flaky thing', 5);
    expect(again.reinforced).toBe(false);
    expect(s.active()).toHaveLength(1);
  });

  it('digest ranks by reinforcement then recency', () => {
    const s = new LessonStore();
    s.capture('A', 0);
    s.capture('B', 1);
    s.capture('B', 2); // B → 2 reinforcements
    s.capture('C', 3);
    s.capture('A', 4); // A → 2 reinforcements, updated later than B
    const digest = s.digest();
    // A and B both have 2; A updated at 4 > B at 2 → A first. Then B, then C (1).
    expect(digest.map((l) => l.text)).toEqual(['A', 'B', 'C']);
  });

  it('digest honors a limit', () => {
    const s = new LessonStore();
    s.capture('A', 0);
    s.capture('B', 0);
    s.capture('C', 0);
    expect(s.digest(2)).toHaveLength(2);
  });

  it('supersede throws for an unknown lesson', () => {
    const s = new LessonStore();
    expect(() => s.supersede('nope', 'x', 0)).toThrow(/Unknown lesson/);
  });
});

describe('LessonStore WS16 — reinforce-on-use, provenance, use-weighted digest', () => {
  it('defaults to agent-derived provenance and zero uses', () => {
    const store = new LessonStore();
    const { lesson } = store.capture('trace wiring before claiming behavior', 100);
    expect(lesson.provenance).toBe('agent-derived');
    expect(lesson.uses).toBe(0);
  });

  it('capture can mark user-authored provenance and upgrades on re-capture', () => {
    const store = new LessonStore();
    store.capture('always run the quiet test runner', 100); // agent-derived
    const re = store.capture('always run the quiet test runner', 200, 'user-authored');
    expect(re.reinforced).toBe(true);
    expect(re.lesson.provenance).toBe('user-authored');
  });

  it('reinforceOnUse bumps uses AND reinforcements; unknown/deprecated → undefined', () => {
    const store = new LessonStore();
    const { lesson } = store.capture('acquire mutex before identity write', 100);
    const used = store.reinforceOnUse(lesson.id, 200);
    expect(used?.uses).toBe(1);
    expect(used?.reinforcements).toBe(2);
    expect(store.reinforceOnUse('nope', 300)).toBeUndefined();
    store.deprecate(lesson.id);
    expect(store.reinforceOnUse(lesson.id, 400)).toBeUndefined();
  });

  it('digest ranks used lessons above merely-captured ones at equal capture count', () => {
    const store = new LessonStore();
    const a = store.capture('lesson A', 100).lesson;
    store.capture('lesson B', 100);
    store.reinforceOnUse(a.id, 200); // A used once → higher reinforcements
    expect(store.digest()[0].text).toBe('lesson A');
  });

  it('supersede carries uses and provenance forward', () => {
    const store = new LessonStore();
    const { lesson } = store.capture('old lesson', 100, 'user-authored');
    store.reinforceOnUse(lesson.id, 150);
    const next = store.supersede(lesson.id, 'new lesson', 200);
    expect(next.provenance).toBe('user-authored');
    expect(next.uses).toBe(1);
  });
});
