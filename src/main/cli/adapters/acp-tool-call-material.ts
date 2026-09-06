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
