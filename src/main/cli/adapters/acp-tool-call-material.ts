/**
 * Tool-call argument and result material for `AcpCliAdapter`.
 *
 * Live probe of `cursor-agent acp` (2026-09-05): grep and Read File arrive
 * with `rawInput: {}` (only `execute` carries a `command`), and every result
 * comes back in `rawOutput`, never in `content` — Read File → `{ content }`,
 * execute → `{ exitCode, stdout, stderr }`, grep → `{ totalMatches, truncated }`.
 * The adapter used to ignore `rawOutput` and forward the empty `rawInput`, so
 * every Cursor tool_result was `''` and every grep hashed to the same call;
 * the loop's repeat detectors then parked a run that was making progress
 * (`loop-1788631546543-593083f8`).
 *
 * Live wire capture of `grok agent stdio` (2026-09-24, LT-612): its `execute`
 * result carries the same information under different keys — a terminal
 * `tool_call_update` reports `{ type: "Bash", output_for_prompt, exit_code,
 * command, current_dir, ... }`, i.e. `exit_code` (snake_case), not Cursor's
 * `exitCode`. `content` (a text block on the notification, not `rawOutput`)
 * already carries the human-readable stdout/stderr, so `renderAcpRawOutput()`
 * is not the affected path — only `acpToolFailed()`'s `rawOutput.exitCode`
 * lookup was, and it now also reads `exit_code`. See `acpExitCode()` below.
 */

import { buildToolOutcomeMessage } from '../../../shared/types/tool-outcome';
import type { OutputMessage } from '../../../shared/types/instance.types';
import type { AcpToolKind } from '../../../shared/types/cli.types';

/** Longest `rawOutput` rendering kept as a tool_result; the rest is dropped with a marker. */
export const ACP_RAW_OUTPUT_MAX_CHARS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Arguments for the emitted `CliToolCall`. `rawInput` is attached only when
 * it carries keys: an empty record is not evidence about the call. Consumers
 * that hash arguments recognise the resulting `{ kind }`-only shape as
 * "uncaptured" via `readCapturedToolArguments()` and fail open.
 */
export function buildAcpToolCallArguments(
  kind: AcpToolKind,
  rawInput: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return isRecord(rawInput) && Object.keys(rawInput).length > 0
    ? { kind, rawInput }
    : { kind };
}

/**
 * LT-196: the minable `input` for an ACP `tool_use` message. The correction
 * miner opens an invocation only when it can read `metadata.input.command`;
 * without it every ACP tool call was dropped before correlation and nothing
 * was ever mined for Copilot/Cursor/Grok.
 *
 * Only the command is carried. `rawInput` is arbitrary provider input and can
 * hold a whole file body on a write/edit call — persisting all of it into
 * every archived transcript is neither needed nor wanted.
 */
export function buildAcpMinableInput(
  rawInput: Record<string, unknown> | undefined,
): { input: { command: string } } | Record<string, never> {
  const command = rawInput?.['command'];
  return typeof command === 'string' && command.trim() ? { input: { command } } : {};
}

/**
 * LT-196: the fallback outcome record for an ACP tool call that produced no
 * rendered output.
 *
 * The visible `tool_result` — which carries `is_error` for the miner — is only
 * emitted when there is output to show. An exit-code-only failure therefore
 * left the miner's open invocation with nothing to close it, and the call was
 * silently dropped rather than mined. This supplies the invisible record in
 * exactly that case, so there is always exactly one correlated closing
 * message and never two racing to close first.
 *
 * Returns null when the visible message already covered it, or when the call
 * was `cancelled` — neither success nor failure, and a false success would
 * credit the miner +0.15 confidence for a fix that never ran.
 */
export function buildAcpToolOutcomeFallback(
  params: { toolCallId: string; status: string; title: string; hasRenderedOutput: boolean; rawOutput?: Record<string, unknown> },
  id: string,
  timestamp: number,
): OutputMessage | null {
  if (params.hasRenderedOutput) return null;
  if (params.status !== 'completed' && params.status !== 'failed') return null;
  return buildToolOutcomeMessage(
    { toolUseId: params.toolCallId, isError: acpToolFailed(params.status, params.rawOutput), toolName: params.title },
    id,
    timestamp,
  );
}

/** A status after which an ACP tool call sends no further updates. */
export function isAcpTerminalToolStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * The exit code of a completed `execute` tool call, from whichever field name
 * the agent's own ACP server used.
 *
 * LT-612 wire capture (2026-09-24): `cursor-agent acp` sends `rawOutput.exitCode`
 * (camelCase). `grok agent stdio` sends the same information as
 * `rawOutput.exit_code` (snake_case) — confirmed on a real terminal
 * `tool_call_update` for both a failing (`exit_code: 2`) and a succeeding
 * (`exit_code: 0`) bare shell command. `acpToolFailed()` originally read only
 * the camelCase key, so every Grok completed call fell through to "not
 * failed" regardless of the real exit status. Both keys are read here; if a
 * future provider sends both, the numeric one closest to "the real exit
 * code" is `exitCode` first (Cursor's existing contract), falling back to
 * `exit_code`.
 */
function acpExitCode(rawOutput?: Record<string, unknown>): number | undefined {
  const camelCase = rawOutput?.['exitCode'];
  if (typeof camelCase === 'number') return camelCase;
  const snakeCase = rawOutput?.['exit_code'];
  if (typeof snakeCase === 'number') return snakeCase;
  return undefined;
}

function acpToolFailed(status: string, rawOutput?: Record<string, unknown>): boolean {
  if (status === 'failed') return true;
  if (status !== 'completed') return false;
  const exitCode = acpExitCode(rawOutput);
  return typeof exitCode === 'number' && exitCode !== 0;
}

/**
 * The single visible `tool_result` for an ACP tool call.
 *
 * ACP `tool_call_update` REPLACES a call's content, so Copilot re-sends the
 * whole output on every progress update. Emitting one message per update
 * stored each result two or three times over in the buffer, the persisted
 * transcript and the History archive. The adapter holds the latest snapshot
 * and emits it once, when the call settles or its turn ends.
 */
export function buildAcpToolResultMessage(
  params: { toolCallId: string; title: string; status: string; sessionUpdate: string; output: string; rawOutput?: Record<string, unknown> },
  id: string,
  timestamp: number,
): OutputMessage {
  const { toolCallId, title, status, sessionUpdate, output } = params;
  return {
    id,
    timestamp,
    type: 'tool_result',
    content: output,
    metadata: {
      sessionUpdate,
      toolCallId,
      title,
      status,
      transport: 'acp',
      // LT-196: outcome rides this already-correlated message; `cancelled`
      // and an unsettled call are neither outcome, so it is left unset.
      ...(status === 'completed' || status === 'failed' ? { is_error: acpToolFailed(status, params.rawOutput) } : {}),
    },
  };
}

/**
 * Render an ACP `rawOutput` object as tool_result text. Returns '' when there
 * is nothing to render, so callers can fall through to "no result".
 */
export function renderAcpRawOutput(rawOutput: unknown): string {
  if (!isRecord(rawOutput) || Object.keys(rawOutput).length === 0) return '';
  let rendered: string;
  const content = rawOutput['content'];
  const stdout = rawOutput['stdout'];
  const stderr = rawOutput['stderr'];
  if (typeof content === 'string') {
    rendered = content;
  } else if (typeof stdout === 'string' || typeof stderr === 'string') {
    const parts: string[] = [];
    if (typeof stdout === 'string' && stdout) parts.push(stdout);
    if (typeof stderr === 'string' && stderr) parts.push(`--- stderr ---\n${stderr}`);
    const exitCode = rawOutput['exitCode'];
    if (typeof exitCode === 'number' && exitCode !== 0) parts.push(`(exit code ${exitCode})`);
    rendered = parts.join('\n');
  } else {
    try {
      rendered = JSON.stringify(rawOutput);
    } catch {
      return '';
    }
  }
  if (rendered.length > ACP_RAW_OUTPUT_MAX_CHARS) {
    return `${rendered.slice(0, ACP_RAW_OUTPUT_MAX_CHARS)}\n… [truncated ${rendered.length - ACP_RAW_OUTPUT_MAX_CHARS} chars]`;
  }
  return rendered;
}
