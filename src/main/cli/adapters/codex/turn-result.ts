import type { CliToolCall, TurnInterruptCompletion } from '../base-cli-adapter';
import type { TurnCaptureState } from './app-server-types';
import { extractCodexAppServerError, formatCodexAppServerError } from './app-server-errors';
import { getCommandAggregatedOutput, getCommandExitCode } from './thread-item-accessors';

/** Converts a captured turn into the completion reported to an interrupt caller. */
export function toTurnInterruptCompletion(state: TurnCaptureState): TurnInterruptCompletion {
  const finalStatus = state.finalTurn?.status;
  const reason = state.error instanceof Error
    ? state.error.message
    : typeof state.error === 'string'
      ? state.error
      : state.finalTurn?.error !== undefined && state.finalTurn.error !== null
        ? formatCodexAppServerError(extractCodexAppServerError({ error: state.finalTurn.error }))
        : undefined;

  if (finalStatus === 'interrupted') {
    return { status: 'interrupted', turnId: state.turnId ?? undefined, reason };
  }
  if (finalStatus === 'completed') {
    return { status: 'completed', turnId: state.turnId ?? undefined, reason };
  }
  if (finalStatus === 'failed') {
    return { status: 'rejected', turnId: state.turnId ?? undefined, reason: reason ?? 'Codex turn failed' };
  }
  return { status: state.completed ? 'completed' : 'unknown', turnId: state.turnId ?? undefined, reason };
}

/** Converts captured commands and file changes into response tool calls. */
export function buildToolCallsFromTurnState(state: TurnCaptureState): CliToolCall[] {
  const toolCalls: CliToolCall[] = [];
  for (const cmd of state.commandExecutions) {
    const exitCode = getCommandExitCode(cmd);
    toolCalls.push({
      id: cmd.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: 'command_execution',
      arguments: { command: cmd.command, exitCode, status: cmd.status },
      result: getCommandAggregatedOutput(cmd) || undefined,
    });
  }
  for (const fc of state.fileChanges) {
    toolCalls.push({
      id: fc.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: 'file_change',
      arguments: { path: fc.path, changeType: fc.changeType },
      result: fc.description || undefined,
    });
  }
  return toolCalls;
}
