/**
 * Composer editing primitives (Pi Task 16).
 *
 * Pure, DOM-free helpers that operate on a plain textarea edit-state
 * ({ text, selectionStart, selectionEnd }) so word-motion, kill-ring, and yank
 * behaviour is unit-testable without a real textarea. The component maps the
 * result back onto the actual `<textarea>` (value + selection).
 */

export interface TextareaEditState {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** Index one word forward from `pos` (skip non-word chars, then word chars). */
export function nextWordBoundary(text: string, pos: number): number {
  let i = Math.max(0, Math.min(pos, text.length));
  while (i < text.length && !isWordChar(text[i])) i++;
  while (i < text.length && isWordChar(text[i])) i++;
  return i;
}

/** Index one word backward from `pos` (skip non-word chars, then word chars). */
export function prevWordBoundary(text: string, pos: number): number {
  let i = Math.max(0, Math.min(pos, text.length));
  while (i > 0 && !isWordChar(text[i - 1])) i--;
  while (i > 0 && isWordChar(text[i - 1])) i--;
  return i;
}

/**
 * A minimal emacs-style kill ring. Consecutive kills (caller passes
 * `accumulate: true`) merge into the newest entry; `prepend` puts a
 * backward-kill's text in front so a run of backward kills reads left-to-right.
 */
export class KillRing {
  private ring: string[] = [];
  private index = 0;

  push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
    if (!text) return;
    if (opts.accumulate && this.ring.length > 0) {
      const last = this.ring.length - 1;
      this.ring[last] = opts.prepend ? text + this.ring[last] : this.ring[last] + text;
    } else {
      this.ring.push(text);
    }
    this.index = this.ring.length - 1;
  }

  /** The current ring entry (most recent unless {@link rotate} moved the cursor). */
  peek(): string | undefined {
    return this.ring[this.index];
  }

  /** Move to the previous ring entry (emacs `yank-pop`), wrapping around. */
  rotate(): void {
    if (this.ring.length === 0) return;
    this.index = (this.index - 1 + this.ring.length) % this.ring.length;
  }

  get length(): number {
    return this.ring.length;
  }
}

export type ComposerUndoKind = 'insert' | 'kill';

interface ComposerUndoEntry {
  readonly before: TextareaEditState;
  readonly after: TextareaEditState;
  readonly kind: ComposerUndoKind;
}

/**
 * Undo stack for explicit composer editing commands. Ordinary typing stays on
 * the browser's native textarea undo stack; this stack covers programmatic
 * kill/yank edits that browsers do not reliably record.
 */
export class ComposerUndoStack {
  private entries: ComposerUndoEntry[] = [];

  push(before: TextareaEditState, after: TextareaEditState, kind: ComposerUndoKind): void {
    if (before.text === after.text && before.selectionStart === after.selectionStart && before.selectionEnd === after.selectionEnd) {
      return;
    }

    const last = this.entries.at(-1);
    if (last && last.kind === kind && last.after.text === before.text) {
      this.entries[this.entries.length - 1] = {
        before: last.before,
        after,
        kind,
      };
      return;
    }

    this.entries.push({ before, after, kind });
  }

  undo(): TextareaEditState | null {
    const entry = this.entries.pop();
    return entry?.before ?? null;
  }

  get length(): number {
    return this.entries.length;
  }
}

/**
 * Move the caret one word left/right. `extend` grows the selection from the
 * stationary edge; otherwise the selection collapses onto the moved position.
 */
export function moveByWord(
  state: TextareaEditState,
  direction: 'left' | 'right',
  extend: boolean,
): TextareaEditState {
  const active = direction === 'right' ? state.selectionEnd : state.selectionStart;
  const anchor = direction === 'right' ? state.selectionStart : state.selectionEnd;
  const target = direction === 'right'
    ? nextWordBoundary(state.text, active)
    : prevWordBoundary(state.text, active);
  if (!extend) {
    return { text: state.text, selectionStart: target, selectionEnd: target };
  }
  return {
    text: state.text,
    selectionStart: Math.min(anchor, target),
    selectionEnd: Math.max(anchor, target),
  };
}

/**
 * Delete a word in the given direction (or the current selection, if any) and
 * push the removed text onto the kill ring.
 */
export function killWord(
  state: TextareaEditState,
  direction: 'left' | 'right',
  ring: KillRing,
): TextareaEditState {
  let from: number;
  let to: number;
  if (state.selectionStart !== state.selectionEnd) {
    // A non-empty selection is killed as-is.
    from = state.selectionStart;
    to = state.selectionEnd;
  } else if (direction === 'left') {
    to = state.selectionStart;
    from = prevWordBoundary(state.text, to);
  } else {
    from = state.selectionEnd;
    to = nextWordBoundary(state.text, from);
  }
  const killed = state.text.slice(from, to);
  if (!killed) return state;
  ring.push(killed, { prepend: direction === 'left', accumulate: true });
  const next = state.text.slice(0, from) + state.text.slice(to);
  return { text: next, selectionStart: from, selectionEnd: from };
}

export type ComposerEditingCommand =
  | 'word-left'
  | 'word-right'
  | 'select-word-left'
  | 'select-word-right'
  | 'kill-word-left'
  | 'kill-word-right'
  | 'yank'
  | 'undo';

export type ComposerEditingAction =
  | 'composer.word-left'
  | 'composer.word-right'
  | 'composer.select-word-left'
  | 'composer.select-word-right'
  | 'composer.kill-word-left'
  | 'composer.kill-word-right'
  | 'composer.yank'
  | 'composer.undo-edit';

export const COMPOSER_EDITING_ACTIONS: readonly ComposerEditingAction[] = [
  'composer.word-left',
  'composer.word-right',
  'composer.select-word-left',
  'composer.select-word-right',
  'composer.kill-word-left',
  'composer.kill-word-right',
  'composer.yank',
  'composer.undo-edit',
];

const ACTION_TO_COMMAND: Record<ComposerEditingAction, ComposerEditingCommand> = {
  'composer.word-left': 'word-left',
  'composer.word-right': 'word-right',
  'composer.select-word-left': 'select-word-left',
  'composer.select-word-right': 'select-word-right',
  'composer.kill-word-left': 'kill-word-left',
  'composer.kill-word-right': 'kill-word-right',
  'composer.yank': 'yank',
  'composer.undo-edit': 'undo',
};

export function composerEditingCommandForAction(actionId: string): ComposerEditingCommand | null {
  return ACTION_TO_COMMAND[actionId as ComposerEditingAction] ?? null;
}

/**
 * Apply a matched command to an edit-state, returning the next state. Pure — the
 * caller maps the result back onto the real textarea (value + selection).
 */
export function applyComposerEditingCommand(
  command: ComposerEditingCommand,
  state: TextareaEditState,
  ring: KillRing,
): TextareaEditState {
  switch (command) {
    case 'word-left': return moveByWord(state, 'left', false);
    case 'word-right': return moveByWord(state, 'right', false);
    case 'select-word-left': return moveByWord(state, 'left', true);
    case 'select-word-right': return moveByWord(state, 'right', true);
    case 'kill-word-left': return killWord(state, 'left', ring);
    case 'kill-word-right': return killWord(state, 'right', ring);
    case 'yank': return yank(state, ring);
    case 'undo': return state;
  }
}

export interface ComposerEditingResult {
  /** Whether the event was an editing command (and thus consumed). */
  readonly handled: boolean;
  /** Whether the textarea text (not just the selection) changed. */
  readonly changed: boolean;
}

function textareaState(textarea: HTMLTextAreaElement): TextareaEditState {
  return {
    text: textarea.value,
    selectionStart: textarea.selectionStart ?? textarea.value.length,
    selectionEnd: textarea.selectionEnd ?? textarea.value.length,
  };
}

function applyStateToTextarea(textarea: HTMLTextAreaElement, before: TextareaEditState, after: TextareaEditState): boolean {
  const changed = after.text !== before.text;
  if (changed) textarea.value = after.text;
  textarea.setSelectionRange(after.selectionStart, after.selectionEnd);
  return changed;
}

function undoKindForCommand(command: ComposerEditingCommand): ComposerUndoKind | null {
  if (command === 'kill-word-left' || command === 'kill-word-right') return 'kill';
  if (command === 'yank') return 'insert';
  return null;
}

export function applyComposerEditingActionToTextarea(
  textarea: HTMLTextAreaElement,
  actionId: string,
  ring: KillRing,
  undoStack?: ComposerUndoStack,
): ComposerEditingResult {
  const command = composerEditingCommandForAction(actionId);
  if (!command) return { handled: false, changed: false };
  const before = textareaState(textarea);

  if (command === 'undo') {
    const restored = undoStack?.undo();
    if (!restored) return { handled: true, changed: false };
    return { handled: true, changed: applyStateToTextarea(textarea, before, restored) };
  }

  const after = applyComposerEditingCommand(command, before, ring);
  const changed = applyStateToTextarea(textarea, before, after);
  const undoKind = undoKindForCommand(command);
  if (changed && undoKind) {
    undoStack?.push(before, after, undoKind);
  }
  return { handled: true, changed };
}

/** Insert the current kill-ring entry at the caret (replacing any selection). */
export function yank(state: TextareaEditState, ring: KillRing): TextareaEditState {
  const text = ring.peek();
  if (text === undefined || text === '') return state;
  const next = state.text.slice(0, state.selectionStart) + text + state.text.slice(state.selectionEnd);
  const caret = state.selectionStart + text.length;
  return { text: next, selectionStart: caret, selectionEnd: caret };
}
