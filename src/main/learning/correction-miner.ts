/**
 * WS-B8 correction miner — pure, singleton-free fail->fix pair mining over a
 * single session's already-loaded `OutputMessage[]` transcript.
 *
 * Corpus survey (2026-07-30): the only reliably queryable per-tool-call
 * signal in AIO's archived history (`HistoryManager.loadConversation`) is the
 * `OutputMessage` stream every CLI adapter emits — `type: 'tool_use'` /
 * `type: 'tool_result'` pairs correlated by an id, where `tool_result`
 * carries `metadata.is_error: boolean` on Claude, ACP, Codex-exec, Cursor,
 * and Copilot adapters (Gemini does not set it explicitly and is silently
 * skipped — no false signal is manufactured). Command text is read from
 * `metadata.input.command` / `metadata.arguments.command` / `metadata.command`,
 * which covers the Bash/shell-style tool shapes those adapters use; tools
 * without a command string (Read/Edit/WebFetch/...) are not minable by
 * design — "base command" has no meaning for them.
 *
 * This module never touches the database, redaction, or governance store —
 * see `learning-scan-service.ts` for the bounded/checkpointed orchestration,
 * cross-session aggregation, egress redaction, and proposal capture.
 */

export type ErrorClass =
  | 'PermissionDenied'
  | 'CommandNotFound'
  | 'UnknownFlag'
  | 'MissingArg'
  | 'WrongSyntax'
  | 'WrongPath';

/** Minimal shape the miner needs from `OutputMessage` — avoids a hard renderer/shared coupling. */
export interface MinableMessage {
  type: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface ToolInvocation {
  /** Index into the source invocation list (used for windowed lookahead). */
  index: number;
  timestamp: number;
  toolName: string;
  command: string;
  /** The tool_result content, when observed. */
  resultText: string | null;
  /** `null` when the outcome was never observed (no matching tool_result). */
  isError: boolean | null;
}

export interface CorrectionCandidate {
  baseCommand: string;
  errorClass: ErrorClass;
  failCommand: string;
  fixCommand: string;
  /** Outcome of the fix attempt: `false` = confirmed success, `null` = unobserved. */
  fixIsError: boolean | null;
  confidence: number;
}

/**
 * Tools that only navigate or inspect the filesystem. Excluded from mining
 * entirely (both as the "fail" and the "fix" side of a pair) — a `cd`/`ls`
 * failing on one path and succeeding on a different path a moment later is
 * ordinary directory exploration, not a correction worth learning as a rule.
 */
const EXPLORATION_BASE_COMMANDS = new Set(['cd', 'ls', 'dir', 'pwd', 'find', 'tree']);

/** How many invocations ahead of a failure to search for its fix, bounded to keep pairing local. */
const DEFAULT_LOOKAHEAD = 12;

// ---- Extraction -------------------------------------------------------------

function readStringField(metadata: Record<string, unknown> | undefined, ...path: string[]): string | null {
  if (!metadata) return null;
  let cursor: unknown = metadata;
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' && cursor.trim() ? cursor.trim() : null;
}

function extractCommandText(metadata: Record<string, unknown> | undefined): string | null {
  return (
    readStringField(metadata, 'input', 'command')
    ?? readStringField(metadata, 'arguments', 'command')
    ?? readStringField(metadata, 'command')
  );
}

function extractToolUseId(metadata: Record<string, unknown> | undefined): string | null {
  return (
    readStringField(metadata, 'id')
    ?? readStringField(metadata, 'toolCallId')
    ?? readStringField(metadata, 'callId')
  );
}

function extractResultCorrelationId(metadata: Record<string, unknown> | undefined): string | null {
  return (
    readStringField(metadata, 'tool_use_id')
    ?? readStringField(metadata, 'toolCallId')
    ?? readStringField(metadata, 'callId')
  );
}

function extractIsError(metadata: Record<string, unknown> | undefined): boolean | null {
  const value = metadata?.['is_error'];
  return typeof value === 'boolean' ? value : null;
}

function extractToolName(metadata: Record<string, unknown> | undefined): string {
  return (
    readStringField(metadata, 'name')
    ?? readStringField(metadata, 'toolName')
    ?? 'unknown'
  );
}

/**
 * Correlate `tool_use` / `tool_result` messages into command invocations with
 * a known command string. Messages without an extractable command (non-shell
 * tools, or adapters that don't surface one) are dropped — nothing to mine.
 */
export function extractToolInvocations(messages: readonly MinableMessage[]): ToolInvocation[] {
  const open = new Map<string, { toolName: string; command: string; timestamp: number; index: number }>();
  const invocations: ToolInvocation[] = [];
  let anonymousIndex = 0;

  messages.forEach((message, index) => {
    if (message.type === 'tool_use') {
      const command = extractCommandText(message.metadata);
      if (!command) return;
      const id = extractToolUseId(message.metadata) ?? `__anon_${anonymousIndex++}`;
      open.set(id, {
        toolName: extractToolName(message.metadata),
        command,
        timestamp: message.timestamp ?? Date.now(),
        index,
      });
      return;
    }
    if (message.type === 'tool_result') {
      const correlationId = extractResultCorrelationId(message.metadata);
      const pending = correlationId ? open.get(correlationId) : undefined;
      if (!pending || !correlationId) return;
      open.delete(correlationId);
      const invocation: ToolInvocation = {
        index: pending.index,
        timestamp: pending.timestamp,
        toolName: pending.toolName,
        command: pending.command,
        resultText: message.content ?? null,
        isError: extractIsError(message.metadata),
      };
      invocations.push(invocation);
    }
  });

  return invocations.sort((a, b) => a.index - b.index);
}

/** Executable name from a command string (path-stripped first token). Empty for a blank command. */
export function extractBaseCommand(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0] ?? '';
  if (!firstToken) return '';
  const base = firstToken.split(/[\\/]/).pop() ?? firstToken;
  return base.toLowerCase();
}

function normalizeCommandForCompare(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** True for filesystem-navigation-only tools (see {@link EXPLORATION_BASE_COMMANDS}). */
export function isExplorationCommand(command: string): boolean {
  return EXPLORATION_BASE_COMMANDS.has(extractBaseCommand(command));
}

// ---- Error classification ----------------------------------------------------

const ERROR_CLASS_PATTERNS: { errorClass: ErrorClass; pattern: RegExp }[] = [
  // Checked first: unambiguous and otherwise easily confused with WrongPath.
  { errorClass: 'PermissionDenied', pattern: /permission denied|eacces|access is denied|operation not permitted/i },
  {
    errorClass: 'CommandNotFound',
    pattern: /(?:^|[:\s])command not found\b|is not recognized as an internal or external command|spawn\s+\S+\s+enoent|executable file not found/i,
  },
  {
    errorClass: 'UnknownFlag',
    pattern: /unrecognized (?:option|argument)|unknown (?:option|flag)|invalid option|no such option|unexpected option/i,
  },
  {
    errorClass: 'MissingArg',
    pattern: /missing (?:required )?(?:argument|option|operand)|the following arguments are required|requires? (?:a|an) (?:argument|value)|expected (?:an? )?argument/i,
  },
  { errorClass: 'WrongSyntax', pattern: /syntax error|usage:\s|invalid syntax|unexpected token|parse error/i },
  // Checked last: the broadest / most easily confused pattern set.
  { errorClass: 'WrongPath', pattern: /no such file or directory|cannot find (?:the )?path|enoent|not a directory|directory not found/i },
];

/** Conservative, order-sensitive classification. `null` when nothing matches (skip rather than guess). */
export function classifyError(errorText: string): ErrorClass | null {
  const text = (errorText ?? '').trim();
  if (!text) return null;
  for (const { errorClass, pattern } of ERROR_CLASS_PATTERNS) {
    if (pattern.test(text)) return errorClass;
  }
  return null;
}

// ---- Confidence scoring -------------------------------------------------------

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          currentRow[j - 1] + 1,
          previousRow[j] + 1,
          previousRow[j - 1] + cost,
        ),
      );
    }
    previousRow = currentRow;
  }
  return previousRow[b.length];
}

/** Normalized string similarity in [0, 1]; 1 = identical, 0 = maximally different. */
export function stringSimilarity(a: string, b: string): number {
  const normA = a.trim();
  const normB = b.trim();
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return 1;
  return clamp01(1 - levenshtein(normA, normB) / maxLen);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Confidence for a single observed correction: a base band from how similar
 * the fail/fix command text is (a real edit should still be mostly the same
 * command), plus a bonus when the fix's outcome was confirmed successful and
 * a small penalty when it was never observed. Deliberately capped below 1.0
 * for a single observation — this is a *reviewable* proposal, never a
 * trusted one; occurrence counts (via reinforcement across scans) are what
 * should build confidence over time, not one pass of this function.
 */
export function scoreConfidence(failCommand: string, fixCommand: string, fixIsError: boolean | null): number {
  const similarity = stringSimilarity(failCommand, fixCommand);
  let score = 0.35 + similarity * 0.45;
  if (fixIsError === false) score += 0.15;
  else if (fixIsError === null) score -= 0.05;
  return clamp01(score);
}

// ---- Pair-finding --------------------------------------------------------------

export interface FindCorrectionPairsOptions {
  /** Max invocations to search ahead of a failure for its fix. Default {@link DEFAULT_LOOKAHEAD}. */
  lookahead?: number;
}

/**
 * Find fail->fix pairs among same-base-command invocations, applying the two
 * false-positive filters:
 *  - **TDD red-green**: an identical (normalized) command re-run — the same
 *    test command flipping from fail to pass because the CODE changed, not
 *    the command — is never treated as a correction.
 *  - **Path exploration**: `cd`/`ls`/... are excluded from mining entirely
 *    (see {@link isExplorationCommand}).
 * Unclassifiable failures (no error-class regex match) are conservatively
 * skipped rather than guessed at.
 */
export function findCorrectionPairs(
  invocations: readonly ToolInvocation[],
  options: FindCorrectionPairsOptions = {},
): CorrectionCandidate[] {
  const lookahead = options.lookahead ?? DEFAULT_LOOKAHEAD;
  const ordered = [...invocations].sort((a, b) => a.index - b.index);
  const consumed = new Set<number>();
  const results: CorrectionCandidate[] = [];

  for (let i = 0; i < ordered.length; i++) {
    if (consumed.has(i)) continue;
    const failInv = ordered[i];
    if (failInv.isError !== true) continue;
    if (isExplorationCommand(failInv.command)) continue;

    const errorClass = classifyError(failInv.resultText ?? '');
    if (!errorClass) continue;

    const baseCommand = extractBaseCommand(failInv.command);
    if (!baseCommand) continue;
    const normalizedFail = normalizeCommandForCompare(failInv.command);

    for (let j = i + 1; j < ordered.length && j <= i + lookahead; j++) {
      if (consumed.has(j)) continue;
      const candidate = ordered[j];
      if (extractBaseCommand(candidate.command) !== baseCommand) continue;
      if (isExplorationCommand(candidate.command)) continue;

      const normalizedCandidate = normalizeCommandForCompare(candidate.command);
      if (normalizedCandidate === normalizedFail) {
        // Identical retry (TDD red-green / flaky re-run) — not a correction.
        // Keep scanning forward in case a REAL edit follows later.
        continue;
      }
      if (candidate.isError === true) {
        // Still failing under the same base command — not the fix yet.
        continue;
      }

      results.push({
        baseCommand,
        errorClass,
        failCommand: failInv.command,
        fixCommand: candidate.command,
        fixIsError: candidate.isError,
        confidence: scoreConfidence(failInv.command, candidate.command, candidate.isError),
      });
      consumed.add(j);
      break;
    }
  }

  return results;
}

/** Session-level entry point: extract invocations, then find correction pairs. */
export function mineCorrections(
  messages: readonly MinableMessage[],
  options: FindCorrectionPairsOptions = {},
): CorrectionCandidate[] {
  return findCorrectionPairs(extractToolInvocations(messages), options);
}
