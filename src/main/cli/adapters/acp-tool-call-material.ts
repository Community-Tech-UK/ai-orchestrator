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
  params: { toolCallId: string; status: string; title: string; hasRenderedOutput: boolean },
  id: string,
  timestamp: number,
): OutputMessage | null {
  if (params.hasRenderedOutput) return null;
  if (params.status !== 'completed' && params.status !== 'failed') return null;
  return buildToolOutcomeMessage(
    { toolUseId: params.toolCallId, isError: params.status === 'failed', toolName: params.title },
    id,
    timestamp,
  );
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
