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
 * command, signal, timed_out, current_dir, ... }`, i.e. `exit_code` (snake_case),
 * not Cursor's `exitCode`. `content` (a text block on the notification, not
 * `rawOutput`) already carries the human-readable stdout/stderr, so
 * `renderAcpRawOutput()` is not the affected path — only the exit-code lookup
 * was, and it now also reads `exit_code`. See `acpExitCode()` below.
 *
 * What the exit status MEANS is decided by the shared rule in
 * `shared/tool-outcome.ts`, the same one the Codex transcripts use: a status the
 * command supplied is recorded as `exitCode` and is neutral (a `rg` that found
 * nothing exits 1); only a check (tests, lint, build) that did not pass, or an
 * explicit report that the call did not run to its own exit (`failed` with no
 * exit status, Grok's `timed_out` or `signal`), is a failure.
 */

import { buildToolOutcomeMessage } from '../../../shared/types/tool-outcome';
import { classifyCommandOutcome, readExecutionEvidence, type CommandOutcome } from '../../../shared/tool-outcome';
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

/** What the adapter knows about an ACP tool call when its final update arrives. */
export interface AcpToolOutcomeSource {
  status: string;
  kind?: AcpToolKind;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
}

/**
 * LT-196: the fallback outcome record for an ACP tool call that produced no
 * rendered output.
 *
 * The visible `tool_result` — which carries `is_error` for the miner — is only
 * emitted when there is output to show. A silent failure therefore left the
 * miner's open invocation with nothing to close it, and the call was silently
 * dropped rather than mined. This supplies the invisible record in exactly that
 * case, so there is always exactly one correlated closing message and never two
 * racing to close first. It says "failed" for the same things the visible result
 * would (see `classifyAcpToolOutcome`), including a check that did not pass.
 *
 * Returns null when the visible message already covered it, or when the call
 * was `cancelled` — neither success nor failure, and a false success would
 * credit the miner +0.15 confidence for a fix that never ran.
 */
export function buildAcpToolOutcomeFallback(
  params: AcpToolOutcomeSource & { toolCallId: string; title: string; hasRenderedOutput: boolean },
  id: string,
  timestamp: number,
): OutputMessage | null {
  if (params.hasRenderedOutput) return null;
  const outcome = classifyAcpToolOutcome(params);
  if (!outcome) return null;
  const message = buildToolOutcomeMessage(
    {
      toolUseId: params.toolCallId,
      isError: outcome.isError,
      toolName: params.title,
    },
    id,
    timestamp,
  );
  return { ...message, metadata: { ...message.metadata, ...acpToolOutcomeMetadata(params) } };
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
 * (`exit_code: 0`) bare shell command. The first reader looked only at the
 * camelCase key, so every Grok completed call lost its real exit status. Both
 * keys are read here; if a future provider sends both, the numeric one closest
 * to "the real exit code" is `exitCode` first (Cursor's existing contract),
 * falling back to `exit_code`. Copilot's and OpenCode's shapes were not captured.
 */
function acpExitCode(rawOutput?: Record<string, unknown>): number | undefined {
  const camelCase = rawOutput?.['exitCode'];
  if (typeof camelCase === 'number') return camelCase;
  const snakeCase = rawOutput?.['exit_code'];
  if (typeof snakeCase === 'number') return snakeCase;
  return undefined;
}

/**
 * The shell command of an ACP call: `rawInput.command` (where an `execute` call
 * carries it) or, failing that, the `command` Grok repeats in its terminal
 * `rawOutput`. An argv array is joined into one line.
 */
function acpCommandText(rawInput?: Record<string, unknown>, rawOutput?: Record<string, unknown>): string | undefined {
  for (const value of [rawInput?.['command'], rawOutput?.['command']]) {
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string')) return value.join(' ');
  }
  return undefined;
}

/** How an ACP tool call ended: its `is_error`, and for a command the shared command outcome. */
export interface AcpToolOutcome {
  isError: boolean;
  /** Present for a command (an `execute` call, or any call that names a command or reports an exit status). */
  command?: CommandOutcome;
}

/**
 * Judge a settled ACP tool call by the shared rule (`shared/tool-outcome.ts`).
 * Returns null while the call is unsettled or when it was `cancelled`: neither a
 * success nor a failure, and the exit status of a call that was cancelled
 * part-way is not a verdict either.
 *
 * A command is recognised by its kind, its command string or an exit status in
 * its output, because servers label shell tools differently. Everything else
 * fails only when the server says it failed (a failed edit stays an error).
 */
export function classifyAcpToolOutcome(source: AcpToolOutcomeSource): AcpToolOutcome | null {
  if (source.status !== 'completed' && source.status !== 'failed') return null;
  const exitCode = acpExitCode(source.rawOutput);
  const command = acpCommandText(source.rawInput, source.rawOutput);
  if ((source.kind !== undefined && source.kind !== 'execute' && source.kind !== 'other')
    || (source.kind !== 'execute' && command === undefined && exitCode === undefined)) {
    return { isError: source.status === 'failed' };
  }
  const outcome = classifyCommandOutcome({
    command,
    exitCode,
    status: source.status,
    ...readExecutionEvidence(source.rawOutput),
  });
  return { isError: outcome.isError, command: outcome };
}

/** Closed outcome facts shared by the visible, silent and raw result transports. */
export function acpToolOutcomeMetadata(source: AcpToolOutcomeSource): Record<string, unknown> {
  const outcome = classifyAcpToolOutcome(source);
  return {
    ...(outcome ? { is_error: outcome.isError } : {}),
    ...(outcome?.command ? {
      ...(outcome.command.exitCode === undefined ? {} : { exitCode: outcome.command.exitCode }),
      isCheck: outcome.command.isCheck,
      checkFailed: outcome.command.checkFailed,
    } : {}),
  };
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
  params: AcpToolOutcomeSource & { toolCallId: string; title: string; sessionUpdate: string; output: string },
  id: string,
  timestamp: number,
): OutputMessage {
  const { toolCallId, title, status, sessionUpdate, output } = params;
  // LT-196: outcome rides this already-correlated message; `cancelled` and an
  // unsettled call are neither outcome, so it is left unset.
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
      ...acpToolOutcomeMetadata(params),
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
