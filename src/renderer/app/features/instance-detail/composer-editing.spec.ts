import { describe, expect, it } from 'vitest';
import {
  KillRing,
  moveByWord,
  killWord,
  yank,
  nextWordBoundary,
  prevWordBoundary,
  matchComposerEditingCommand,
  applyComposerEditingCommand,
  applyEditingToTextarea,
  type TextareaEditState,
} from './composer-editing';

function keyEvent(over: Partial<{ key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }>) {
  return { key: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over };
}

function state(text: string, start: number, end = start): TextareaEditState {
  return { text, selectionStart: start, selectionEnd: end };
}

describe('word boundaries', () => {
  it('finds the next/prev word boundary skipping punctuation and whitespace', () => {
    const text = 'hello,  world foo';
    expect(nextWordBoundary(text, 0)).toBe(5); // end of "hello"
    expect(nextWordBoundary(text, 5)).toBe(13); // skip ",  " then "world"
    expect(prevWordBoundary(text, text.length)).toBe(14); // start of "foo"
    expect(prevWordBoundary(text, 5)).toBe(0);
  });

  it('clamps out-of-range positions', () => {
    expect(nextWordBoundary('ab', 99)).toBe(2);
    expect(prevWordBoundary('ab', -5)).toBe(0);
  });
});

describe('moveByWord', () => {
  it('moves right collapsing the selection', () => {
    const next = moveByWord(state('one two three', 0), 'right', false);
    expect(next).toMatchObject({ selectionStart: 3, selectionEnd: 3 });
  });

  it('moves left collapsing the selection', () => {
    const next = moveByWord(state('one two three', 13), 'left', false);
    expect(next).toMatchObject({ selectionStart: 8, selectionEnd: 8 });
  });

  it('extends the selection from the stationary edge', () => {
    const next = moveByWord(state('one two three', 0), 'right', true);
    expect(next).toMatchObject({ selectionStart: 0, selectionEnd: 3 });
  });
});

describe('KillRing', () => {
  it('accumulates consecutive kills into one entry', () => {
    const ring = new KillRing();
    ring.push('two', { prepend: false, accumulate: false });
    ring.push(' three', { prepend: false, accumulate: true });
    expect(ring.length).toBe(1);
    expect(ring.peek()).toBe('two three');
  });

  it('prepends backward kills so a run reads left-to-right', () => {
    const ring = new KillRing();
    ring.push('world', { prepend: true, accumulate: false });
    ring.push('hello ', { prepend: true, accumulate: true });
    expect(ring.peek()).toBe('hello world');
  });

  it('starts a new entry when not accumulating and rotates through history', () => {
    const ring = new KillRing();
    ring.push('first', { prepend: false, accumulate: false });
    ring.push('second', { prepend: false, accumulate: false });
    expect(ring.length).toBe(2);
    expect(ring.peek()).toBe('second');
    ring.rotate();
    expect(ring.peek()).toBe('first');
    ring.rotate();
    expect(ring.peek()).toBe('second'); // wrapped
  });

  it('ignores empty pushes', () => {
    const ring = new KillRing();
    ring.push('', { prepend: false });
    expect(ring.length).toBe(0);
    expect(ring.peek()).toBeUndefined();
  });
});

describe('killWord', () => {
  it('kills the word to the left of the caret (leaving the surrounding spaces)', () => {
    const ring = new KillRing();
    // Caret at index 7 (the space after "two"); killing left removes "two".
    const next = killWord(state('one two three', 7), 'left', ring);
    expect(next.text).toBe('one  three'); // both spaces around "two" remain
    expect(next.selectionStart).toBe(4);
    expect(ring.peek()).toBe('two');
  });

  it('kills the word to the right of the caret', () => {
    const ring = new KillRing();
    const next = killWord(state('one two three', 3), 'right', ring);
    expect(next.text).toBe('one three');
    expect(ring.peek()).toBe(' two');
  });

  it('kills the current selection when one exists', () => {
    const ring = new KillRing();
    const next = killWord(state('abcdef', 1, 4), 'right', ring);
    expect(next.text).toBe('aef');
    expect(ring.peek()).toBe('bcd');
  });

  it('is a no-op at a boundary with nothing to kill', () => {
    const ring = new KillRing();
    const s = state('word', 4);
    expect(killWord(s, 'right', ring)).toBe(s);
    expect(ring.length).toBe(0);
  });
});

describe('yank', () => {
  it('inserts the ring entry at the caret', () => {
    const ring = new KillRing();
    ring.push('X', { prepend: false });
    const next = yank(state('ac', 1), ring);
    expect(next.text).toBe('aXc');
    expect(next.selectionStart).toBe(2);
    expect(next.selectionEnd).toBe(2);
  });

  it('replaces a selection with the ring entry', () => {
    const ring = new KillRing();
    ring.push('NEW', { prepend: false });
    const next = yank(state('a[old]b', 2, 5), ring);
    expect(next.text).toBe('a[NEW]b');
  });

  it('is a no-op when the ring is empty', () => {
    const ring = new KillRing();
    const s = state('ab', 1);
    expect(yank(s, ring)).toBe(s);
  });
});

describe('matchComposerEditingCommand', () => {
  it('maps the emacs-style editing chords', () => {
    expect(matchComposerEditingCommand(keyEvent({ key: 'y', ctrlKey: true }))).toBe('yank');
    expect(matchComposerEditingCommand(keyEvent({ key: 'd', altKey: true }))).toBe('kill-word-right');
    expect(matchComposerEditingCommand(keyEvent({ key: 'Backspace', altKey: true }))).toBe('kill-word-left');
    expect(matchComposerEditingCommand(keyEvent({ key: 'ArrowLeft', altKey: true }))).toBe('word-left');
    expect(matchComposerEditingCommand(keyEvent({ key: 'ArrowRight', altKey: true, shiftKey: true }))).toBe('select-word-right');
  });

  it('does not match plain typing or unrelated chords', () => {
    expect(matchComposerEditingCommand(keyEvent({ key: 'a' }))).toBeNull();
    expect(matchComposerEditingCommand(keyEvent({ key: 'y', metaKey: true }))).toBeNull();
    expect(matchComposerEditingCommand(keyEvent({ key: 'r', ctrlKey: true }))).toBeNull();
  });

  it('applyComposerEditingCommand dispatches to the right primitive', () => {
    const ring = new KillRing();
    const killed = applyComposerEditingCommand('kill-word-right', state('foo bar', 0), ring);
    expect(killed.text).toBe(' bar');
    expect(ring.peek()).toBe('foo');
    const yanked = applyComposerEditingCommand('yank', state(' bar', 0), ring);
    expect(yanked.text).toBe('foo bar');
  });
});

describe('applyEditingToTextarea (jsdom integration)', () => {
  function makeTextarea(value: string, caret: number): HTMLTextAreaElement {
    const el = document.createElement('textarea');
    el.value = value;
    el.setSelectionRange(caret, caret);
    return el;
  }

  it('kills a word and yanks it back through a real textarea + kill ring', () => {
    const ring = new KillRing();
    const el = makeTextarea('alpha beta', 0);

    const killed = applyEditingToTextarea(el, keyEvent({ key: 'd', altKey: true }), ring);
    expect(killed).toEqual({ handled: true, changed: true });
    expect(el.value).toBe(' beta');

    // Move caret to end and yank the killed word back.
    el.setSelectionRange(el.value.length, el.value.length);
    const yanked = applyEditingToTextarea(el, keyEvent({ key: 'y', ctrlKey: true }), ring);
    expect(yanked).toEqual({ handled: true, changed: true });
    expect(el.value).toBe(' betaalpha');
  });

  it('reports not-handled for a non-editing key and leaves the textarea untouched', () => {
    const ring = new KillRing();
    const el = makeTextarea('hello', 2);
    const result = applyEditingToTextarea(el, keyEvent({ key: 'a' }), ring);
    expect(result.handled).toBe(false);
    expect(el.value).toBe('hello');
  });

  it('moves by word without changing the text', () => {
    const ring = new KillRing();
    const el = makeTextarea('one two', 0);
    const result = applyEditingToTextarea(el, keyEvent({ key: 'ArrowRight', altKey: true }), ring);
    expect(result).toEqual({ handled: true, changed: false });
    expect(el.value).toBe('one two');
    expect(el.selectionStart).toBe(3);
  });
});
