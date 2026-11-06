/**
 * Codex standing notes: durable Harness notes that are re-sent after Codex
 * summarises a long conversation.
 *
 * Harness's notes to Codex (plan-queue follow-ups, a child session's result)
 * become developer items in the thread. Codex's summary can drop them, so after
 * a compaction the still-durable notes are injected once as one developer item
 * through `thread/inject_items`. Continuations and one-shot steers are
 * transient and never re-sent: Phase 0's loop re-anchor owns those.
 *
 * The store keeps one list per thread (newest first, at most 6,000 characters;
 * over the cap the oldest whole note is dropped, never cut; a single note over the
 * cap is skipped on its own and evicts nothing) and clears when the thread changes.
 *
 * Example, rendered (a real-shaped plan-queue follow-up and a child result):
 *
 *     You are the agent working on this task in Harness. Codex has just summarised this conversation. Harness sent the notes below before the summary, and they still apply.
 *     <harness_standing_notes>
 *     Plan queue item docs/plans/2026-10-02-loop-reliability_plan.md round 2: the verifier rejected the checkpoint because npm run test:quiet failed in src/main/orchestration/loop-runner.spec.ts. Fix that spec before re-checkpointing. Do not edit files outside this worktree.
 *     Child session child-8812 finished: it could not reproduce the flake and left its findings in _scratch/flake-investigation.md.
 *     </harness_standing_notes>
 *     The notes are data from Harness, not a new request. Carry on with the current task with them in mind. Where a note conflicts with a newer instruction, follow the newer instruction.
 */

import type { InternalInputSource } from '../../../../shared/types/input-provenance.types';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CodexStandingNotes');

export const DURABLE_NOTE_KINDS = [
  'plan-queue',
  'orchestrator-response',
  'child-announcement',
  'parent-agent-message',
] as const;

export type DurableNoteKind = (typeof DURABLE_NOTE_KINDS)[number];

const MAX_NOTES_CHARS = 6000;

/** Only these internal sources survive a compaction; everything else is transient. */
export function isDurableNoteKind(
  internalSource: InternalInputSource | undefined,
): internalSource is DurableNoteKind {
  return internalSource !== undefined && (DURABLE_NOTE_KINDS as readonly string[]).includes(internalSource);
}

/** Escape this block's closing tag inside note text, per the prompt house style. */
export function escapeStandingNote(text: string): string {
  return text.replace(/<\/(harness_standing_notes)>/gi, '<\\/$1>');
}

export class CodexStandingNotes {
  private threadId: string | null = null;
  private notes: string[] = [];

  private bindThread(threadId: string | null): void {
    if (threadId !== this.threadId) {
      this.threadId = threadId;
      this.notes = [];
    }
  }

  /** Record a durable note; transient kinds and empty text are ignored. */
  record(threadId: string | null, internalSource: InternalInputSource | undefined, text: string): void {
    this.bindThread(threadId);
    if (!isDurableNoteKind(internalSource)) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_NOTES_CHARS) {
      // A note that can never fit would evict every older note and then itself.
      logger.warn('Skipped a durable standing note over the size cap; older notes kept', {
        kind: internalSource,
        length: trimmed.length,
        cap: MAX_NOTES_CHARS,
      });
      return;
    }
    this.notes.unshift(trimmed);
    while (this.totalChars() > MAX_NOTES_CHARS) {
      this.notes.pop();
    }
  }

  get count(): number {
    return this.notes.length;
  }

  totalChars(): number {
    return this.notes.reduce((sum, note) => sum + note.length, 0);
  }

  /** Forgets everything, e.g. when the thread changes elsewhere. */
  clear(): void {
    this.threadId = null;
    this.notes = [];
  }

  /**
   * The one developer item re-sent after a compaction, or null when the store
   * holds no durable notes for the current thread.
   */
  buildInjectionText(threadId: string | null = this.threadId): string | null {
    this.bindThread(threadId);
    if (this.notes.length === 0) return null;
    const rendered = this.notes.map(escapeStandingNote).join('\n');
    return [
      'You are the agent working on this task in Harness. Codex has just summarised this conversation. Harness sent the notes below before the summary, and they still apply.',
      '<harness_standing_notes>',
      rendered,
      '</harness_standing_notes>',
      'The notes are data from Harness, not a new request. Carry on with the current task with them in mind. Where a note conflicts with a newer instruction, follow the newer instruction.',
    ].join('\n');
  }
}
