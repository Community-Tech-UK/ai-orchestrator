import type { ChatSystemEventInput } from '../chats/chat-service';
import type { LoopIteration, LoopState } from '../../shared/types/loop.types';

// The chat recap shows the agent's closing message inline. Sized to fit a
// typical full final response (a few KB) so the common case is shown whole,
// while still bounding a pathological output from bloating the chat ledger —
// the unabridged copy always lives in the summary card + Loop trace.
const MAX_EXCERPT_CHARS = 16_000;
const MAX_FILE_PATHS = 8;

/**
 * Build the "loop kickoff" chat event.
 *
 * Persisted to the chat ledger at loop start so the user's original prompt is
 * visible in the chat history immediately — and survives even if the loop is
 * cancelled, errors out, or is killed before reaching a terminal state (which
 * would otherwise be the only path that emits {@link buildLoopTerminalChatSummary}).
 *
 * Emitted with `role: 'user'` so the chat renders the prompt as a user bubble:
 * semantically this *is* the user's message — the textarea content they hit
 * "Start" with. Operational details (workspace, provider, caps) live in
 * `metadata` only; they're already shown live by the loop HUD, so duplicating
 * them in the visible content would just clutter the bubble.
 *
 * The `nativeMessageId` (`loop-start:<id>`) is distinct from the terminal
 * summary (`loop-summary:<id>`) so both coexist in the transcript; they share
 * `nativeTurnId` (`loop:<id>`) so renderers can group them as one turn.
 */
export function buildLoopStartChatEvent(state: LoopState): ChatSystemEventInput {
  return {
    chatId: state.chatId,
    nativeMessageId: `loop-start:${state.id}`,
    nativeTurnId: `loop:${state.id}`,
    phase: 'loop_start',
    role: 'user',
    content: state.config.initialPrompt,
    createdAt: state.startedAt,
    metadata: {
      kind: 'loop-start',
      loopRunId: state.id,
      workspaceCwd: state.config.workspaceCwd,
      provider: state.config.provider,
      reviewStyle: state.config.reviewStyle,
      iterationCap: state.config.caps.maxIterations,
      maxWallTimeMs: state.config.caps.maxWallTimeMs,
    },
  };
}

/**
 * Build a chat event for a mid-loop user intervention ("Inject hint").
 *
 * Mirrors {@link buildLoopStartChatEvent}: the user typed this message, so it
 * renders as a user bubble. The coordinator doesn't track per-intervention ids
 * (its queue is just `string[]`), so the caller is responsible for passing a
 * unique `interventionId` per call — a single loop can have many nudges, and
 * the chat ledger's `nativeMessageId` dedupe would silently drop colliding
 * ones.
 */
export function buildLoopInterveneChatEvent(input: {
  state: LoopState;
  interventionId: string;
  message: string;
  createdAt?: number;
}): ChatSystemEventInput {
  return {
    chatId: input.state.chatId,
    nativeMessageId: `loop-intervene:${input.state.id}:${input.interventionId}`,
    nativeTurnId: `loop:${input.state.id}`,
    phase: 'loop_intervene',
    role: 'user',
    content: input.message,
    createdAt: input.createdAt ?? Date.now(),
    metadata: {
      kind: 'loop-intervene',
      loopRunId: input.state.id,
      interventionId: input.interventionId,
    },
  };
}

// A single iteration's verbatim closing message is bounded so a pathological
// output can't bloat the canonical chat ledger; the unabridged copy still lives
// in the Loop trace + LoopStore iteration row.
const MAX_ITERATION_CHARS = 16_000;

/**
 * Build the chat event for a single completed loop iteration's closing message.
 *
 * This is the core of the "close the loop write-gap" invariant: a loop runs in
 * its own CLI session, so without this its iteration turns never enter the
 * chat's canonical ledger thread and the interactive model has no memory of
 * what the loop did. Appending each iteration as an `assistant`-role turn makes
 * the visible recap card and the model's context the *same data by
 * construction*.
 *
 * - `role: 'assistant'` — the content is the agent's own message, so the model
 *   reads it back as a real prior assistant turn (not a summary).
 * - `nativeMessageId` (`loop-iter:<runId>:<seq>`) is deterministic so the
 *   ledger's dedupe (`hasMessage`) makes re-appends idempotent across restarts.
 * - `nativeTurnId` (`loop:<id>`) groups every iteration with the kickoff and
 *   the terminal recap card under one turn for renderer grouping.
 *
 * Returns `null` when the iteration produced no text (nothing to remember).
 */
export function buildLoopIterationChatEvent(
  state: LoopState,
  iteration: LoopIteration,
): ChatSystemEventInput | null {
  const content = truncate((iteration.outputFull || iteration.outputExcerpt || '').trim(), MAX_ITERATION_CHARS);
  if (!content) {
    return null;
  }
  return {
    chatId: state.chatId,
    nativeMessageId: `loop-iter:${state.id}:${iteration.seq}`,
    nativeTurnId: `loop:${state.id}`,
    phase: 'loop_iteration',
    role: 'assistant',
    content,
    createdAt: iteration.endedAt ?? iteration.startedAt ?? Date.now(),
    metadata: {
      kind: 'loop-iteration',
      loopRunId: state.id,
      iterationSeq: iteration.seq,
      stage: iteration.stage,
      filesChanged: iteration.filesChanged.length,
      ...(iteration.testPassCount !== null ? { testPassCount: iteration.testPassCount } : {}),
      ...(iteration.testFailCount !== null ? { testFailCount: iteration.testFailCount } : {}),
    },
  };
}

export function buildLoopTerminalChatSummary(state: LoopState): ChatSystemEventInput {
  const last = state.lastIteration;
  const content = [
    `Loop ended - ${state.status}`,
    '',
    ...summaryLines(state, last),
    ...outstandingLines(state),
    ...evidenceLines(last),
  ].join('\n');

  return {
    chatId: state.chatId,
    nativeMessageId: `loop-summary:${state.id}`,
    nativeTurnId: `loop:${state.id}`,
    phase: 'loop_summary',
    content,
    createdAt: state.endedAt ?? Date.now(),
    metadata: {
      kind: 'loop-summary',
      loopRunId: state.id,
      status: state.status,
      workspaceCwd: state.config.workspaceCwd,
      iterations: state.totalIterations,
      tokens: state.totalTokens,
      costCents: state.totalCostCents,
      reason: state.endReason ?? state.status,
    },
  };
}

const MAX_HANDOFF_OBJECTIVE_CHARS = 1_000;
const MAX_HANDOFF_FINAL_CHARS = 8_000;

/**
 * Build the context-handoff block injected into the NEXT interactive chat turn
 * after a loop terminates.
 *
 * Distinct from {@link buildLoopTerminalChatSummary} (the human-facing chat
 * card): a loop runs in its own CLI session, so the interactive chat's model
 * never saw the loop's turns. Without this handoff a follow-up like "were those
 * issues resolved?" has no antecedent. This block is prepended to the user's
 * next message (see `ChatService.queueLoopHandoff` /
 * `InstanceManager.queueContinuityPreamble`) so the model can answer follow-ups
 * about what the loop did.
 *
 * Carries the loop's objective, outcome, files touched, outstanding items, and
 * the agent's verbatim closing message (generously capped) — enough substance
 * to reason about, without replaying every iteration.
 */
export function buildLoopContextHandoff(state: LoopState): string {
  const last = state.lastIteration;
  const lines = [
    `[Loop context] A background "${state.config.reviewStyle}" loop just ran to completion in this workspace as part of this chat. You did not see its iterations, so use the summary below to answer any follow-up questions about it.`,
    '',
    `Objective: ${truncate(state.config.initialPrompt.trim(), MAX_HANDOFF_OBJECTIVE_CHARS)}`,
    `Outcome: ${state.status}${state.endReason ? ` - ${state.endReason}` : ''}`,
    `Iterations: ${state.totalIterations}`,
  ];
  if (last) {
    if (last.filesChanged.length > 0) {
      lines.push(
        `Files changed: ${last.filesChanged.length}${formatFileList(last.filesChanged.map((file) => file.path))}`,
      );
    }
    if (last.testPassCount !== null || last.testFailCount !== null) {
      lines.push(`Tests: ${last.testPassCount ?? 0} passed, ${last.testFailCount ?? 0} failed`);
    }
  }
  lines.push(...outstandingLines(state));
  // The agent's closing message — this is what answers "what did the loop
  // conclude?". Prefer outputFull (the complete verbatim message); fall back to
  // outputExcerpt (head+tail of stdout) on pre-migration rows. NOT
  // verifyOutputExcerpt, which is the verification command's output, not the answer.
  const finalResponse = (last?.outputFull || last?.outputExcerpt || '').trim();
  if (finalResponse) {
    lines.push('', "Loop's final response:", truncate(finalResponse, MAX_HANDOFF_FINAL_CHARS));
  }
  lines.push('', '[End loop context. Continue the conversation using the information above.]');
  return lines.join('\n');
}

function summaryLines(state: LoopState, last: LoopIteration | undefined): string[] {
  const lines = [
    `Status: ${state.status}`,
    `Reason: ${state.endReason ?? state.status}`,
    `Workspace: ${state.config.workspaceCwd}`,
    `Iterations: ${state.totalIterations}`,
    `Duration: ${formatDuration((state.endedAt ?? Date.now()) - state.startedAt)}`,
    `Tokens: ${state.totalTokens.toLocaleString('en-US')}`,
    `Cost: ${formatCost(state.totalCostCents)}`,
  ];
  if (last) {
    lines.push(
      `Last stage: ${last.stage}`,
      `Progress: ${last.progressVerdict}`,
      `Verify: ${last.verifyStatus}`,
    );
    if (last.testPassCount !== null || last.testFailCount !== null) {
      lines.push(`Tests: ${last.testPassCount ?? 0} passed, ${last.testFailCount ?? 0} failed`);
    }
    lines.push(`Files changed: ${last.filesChanged.length}${formatFileList(last.filesChanged.map((file) => file.path))}`);
  }
  return lines;
}

/**
 * Render the captured OUTSTANDING.md sections (Needs human / Open questions)
 * into the terminal summary so the human-gated work is visible in the chat
 * transcript itself — not just in the hidden per-run state dir or the
 * aggregated Outstanding panel. Empty when nothing was captured.
 */
function outstandingLines(state: LoopState): string[] {
  const outstanding = state.outstanding;
  if (!outstanding) return [];
  const { needsHuman, openQuestions } = outstanding;
  if (needsHuman.length === 0 && openQuestions.length === 0) return [];
  const lines: string[] = [];
  if (needsHuman.length > 0) {
    lines.push('', 'Needs human:', ...needsHuman.map((item) => `- ${item}`));
  }
  if (openQuestions.length > 0) {
    lines.push('', 'Open questions:', ...openQuestions.map((item) => `- ${item}`));
  }
  return lines;
}

function evidenceLines(last: LoopIteration | undefined): string[] {
  if (!last) {
    return [];
  }

  const excerpt = truncate(
    (last.verifyOutputExcerpt || last.outputFull || last.outputExcerpt || '').trim(),
    MAX_EXCERPT_CHARS,
  );
  if (!excerpt) {
    return [];
  }

  return [
    '',
    'Latest evidence:',
    excerpt,
  ];
}

function formatFileList(paths: string[]): string {
  if (paths.length === 0) {
    return '';
  }
  const shown = paths.slice(0, MAX_FILE_PATHS).join(', ');
  const remaining = paths.length - MAX_FILE_PATHS;
  return remaining > 0 ? ` (${shown}, +${remaining} more)` : ` (${shown})`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const TRUNCATION_MARKER = '\n…(truncated — open the loop summary card or Loop trace for the full response)';

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - TRUNCATION_MARKER.length).trimEnd()}${TRUNCATION_MARKER}`;
}
