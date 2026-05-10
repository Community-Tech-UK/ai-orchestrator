import type { ChatSystemEventInput } from '../chats/chat-service';
import type { LoopIteration, LoopState } from '../../shared/types/loop.types';

const MAX_GOAL_CHARS = 1_500;
const MAX_EXCERPT_CHARS = 2_000;
const MAX_FILE_PATHS = 8;

export function buildLoopTerminalChatSummary(state: LoopState): ChatSystemEventInput {
  const last = state.lastIteration;
  const content = [
    `Loop ended - ${state.status}`,
    '',
    ...summaryLines(state, last),
    '',
    'Goal:',
    truncate(state.config.initialPrompt.trim(), MAX_GOAL_CHARS) || '(empty)',
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
