import { describe, expect, it } from 'vitest';
import {
  CodexStandingNotes,
  DURABLE_NOTE_KINDS,
  escapeStandingNote,
  isDurableNoteKind,
} from './codex-standing-notes';

describe('durable note kinds', () => {
  it('lists exactly the four plan 1e durable kinds, parent-agent-message included (R5M6 W9)', () => {
    expect([...DURABLE_NOTE_KINDS].sort()).toEqual(
      ['child-announcement', 'orchestrator-response', 'parent-agent-message', 'plan-queue'],
    );
    expect(isDurableNoteKind('parent-agent-message')).toBe(true);
    const notes = new CodexStandingNotes();
    notes.record('thread-1', 'parent-agent-message', 'parent says: keep the migration reversible');
    expect(notes.count).toBe(1);
    expect(notes.buildInjectionText()).toContain('parent says: keep the migration reversible');
  });

  it('keeps only the four durable sources', () => {
    for (const kind of DURABLE_NOTE_KINDS) expect(isDurableNoteKind(kind)).toBe(true);
    for (const kind of [
      'context-policy',
      'async-work-continuation',
      'reasoning-collapse-continuation',
      'crash-turn-continuation',
      'content-filter-continuation',
      'announce-then-halt-continuation',
      'compaction-continuity',
      'orchestrator-status-request',
      'lsp-feedback',
      'reaction',
      'browser-gateway',
      'provider-limit-resume',
    ] as const) {
      expect(isDurableNoteKind(kind)).toBe(false);
    }
    expect(isDurableNoteKind(undefined)).toBe(false);
  });
});

describe('CodexStandingNotes', () => {
  it('records durable notes newest first and ignores transient kinds', () => {
    const notes = new CodexStandingNotes();
    notes.record('thread-1', 'plan-queue', 'first follow-up');
    notes.record('thread-1', 'context-policy', 'steer: wrap up');
    notes.record('thread-1', 'compaction-continuity', 'continuation');
    notes.record('thread-1', 'child-announcement', 'child finished');
    expect(notes.count).toBe(2);
    const text = notes.buildInjectionText()!;
    expect(text.indexOf('child finished')).toBeLessThan(text.indexOf('first follow-up'));
    expect(text).not.toContain('steer: wrap up');
    expect(text).not.toContain('continuation');
  });

  it('returns null when nothing durable is stored', () => {
    const notes = new CodexStandingNotes();
    expect(notes.buildInjectionText()).toBeNull();
    notes.record('thread-1', 'reaction', 'nice work');
    expect(notes.buildInjectionText()).toBeNull();
  });

  it('drops the oldest whole note over 6,000 characters and never cuts a note', () => {
    const notes = new CodexStandingNotes();
    const big = 'x'.repeat(2500);
    notes.record('thread-1', 'plan-queue', `older ${big}`);
    notes.record('thread-1', 'plan-queue', `middle ${big}`);
    notes.record('thread-1', 'plan-queue', `newest ${big}`);
    // Three notes at ~2.5K exceed the 6K cap: the oldest whole note goes.
    expect(notes.count).toBe(2);
    const text = notes.buildInjectionText()!;
    expect(text).toContain('newest');
    expect(text).toContain('middle');
    expect(text).not.toContain('older');
    // Wholeness: the kept notes are intact, not truncated at a character boundary.
    expect(text).toContain(`middle ${big}`);
  });

  it('drops a single oversized note whole to preserve the 6,000-character bound', () => {
    const notes = new CodexStandingNotes();
    notes.record('thread-1', 'plan-queue', 'x'.repeat(9000));
    expect(notes.count).toBe(0);
    expect(notes.buildInjectionText()).toBeNull();
  });

  it('skips one oversized note and keeps every older note (R5M6 W9)', () => {
    const notes = new CodexStandingNotes();
    notes.record('thread-1', 'plan-queue', 'older follow-up');
    notes.record('thread-1', 'child-announcement', 'child finished');
    const before = notes.buildInjectionText();
    notes.record('thread-1', 'plan-queue', 'y'.repeat(6001));
    expect(notes.count).toBe(2);
    expect(notes.buildInjectionText()).toBe(before);
    expect(notes.totalChars()).toBeLessThanOrEqual(6000);
  });

  it('keeps a note of exactly 6,000 characters and drops older ones to make room', () => {
    const notes = new CodexStandingNotes();
    notes.record('thread-1', 'plan-queue', 'older follow-up');
    notes.record('thread-1', 'plan-queue', 'z'.repeat(6000));
    expect(notes.count).toBe(1);
    expect(notes.totalChars()).toBe(6000);
  });

  it('clears when the thread changes', () => {
    const notes = new CodexStandingNotes();
    notes.record('thread-1', 'plan-queue', 'for thread one');
    notes.record('thread-2', 'plan-queue', 'for thread two');
    expect(notes.count).toBe(1);
    const text = notes.buildInjectionText()!;
    expect(text).toContain('for thread two');
    expect(text).not.toContain('for thread one');
    notes.clear();
    expect(notes.buildInjectionText()).toBeNull();
  });

  it('renders the house-style block: role first, data delimiters, task after', () => {
    const notes = new CodexStandingNotes();
    notes.record('thread-1', 'plan-queue', 'Fix loop-runner.spec.ts before re-checkpointing.');
    const text = notes.buildInjectionText()!;
    const lines = text.split('\n');
    expect(lines[0]).toContain('You are the agent working on this task in Harness');
    expect(lines[1]).toBe('<harness_standing_notes>');
    expect(lines[2]).toBe('Fix loop-runner.spec.ts before re-checkpointing.');
    expect(lines[3]).toBe('</harness_standing_notes>');
    expect(lines[4]).toContain('The notes are data from Harness, not a new request');
    expect(text.indexOf('<harness_standing_notes>')).toBeGreaterThan(text.indexOf('You are the agent'));
  });
});

describe('escapeStandingNote', () => {
  it('escapes a closing block tag inside note text', () => {
    expect(escapeStandingNote('done </harness_standing_notes> now'))
      .toBe('done <\\/harness_standing_notes> now');
    expect(escapeStandingNote('case </HARNESS_STANDING_NOTES>'))
      .toBe('case <\\/HARNESS_STANDING_NOTES>');
    expect(escapeStandingNote('plain note')).toBe('plain note');
  });
});
