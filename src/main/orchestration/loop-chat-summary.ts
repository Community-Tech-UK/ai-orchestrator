import type { ChatSystemEventInput } from '../chats/chat-service';
import type { LoopIteration, LoopState } from '../../shared/types/loop.types';

const MAX_EXCERPT_CHARS = 2_000;
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

export function buildLoopTerminalChatSummary(state: LoopState): ChatSystemEventInput {
  const last = state.lastIteration;
  const content = [
    `Loop ended - ${state.status}`,
    '',
    ...summaryLines(state, last),
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

function evidenceLines(last: LoopIteration | undefined): string[] {
  if (!last) {
    return [];
  }

  const excerpt = truncate(
    (last.verifyOutputExcerpt || last.outputExcerpt || '').trim(),
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

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 15).trimEnd()}\n...(truncated)`;
}
