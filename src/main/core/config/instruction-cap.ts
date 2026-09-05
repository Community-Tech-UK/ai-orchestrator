/**
 * T10 — bound the instruction stack injected into a fresh child session.
 *
 * `resolveInstructionStack()` reads every discovered `CLAUDE.md` / `AGENTS.md` /
 * `GEMINI.md` whole and joins them; nothing anywhere caps the result. Verified,
 * not assumed: there is no `maxChars`, `MAX_`, `slice` or `truncat` in
 * `instruction-resolver.ts`, and `instance-system-prompt.ts` prepends the joined
 * text to the system prompt untouched. On this machine the user-global file
 * alone is ~24 KB before any project file joins it, and that whole stack is
 * re-sent on every fresh spawn.
 *
 * **Scope.** This caps the depth-0 fresh-spawn path only. Child instances
 * already skip the stack entirely (`instance-lifecycle.ts`, `depth === 0`), and
 * the post-recycle path re-injects NOTHING — `restartFreshInstance` never calls
 * `assembleInstanceSystemPrompt`, which its own comment records. So T10's
 * "skip re-injection on safe continuations" half was already unconditionally
 * true; only the fresh-spawn half needed building.
 *
 * **Determinism is a hard requirement, not a preference.** The injection site
 * is inside the locked prompt-cache prefix contract (WS-B4), which requires the
 * assembled prompt to be byte-identical for identical inputs. Every value here
 * is a pure function of the input text: no timestamps, no counters, no
 * "as of" wording, no set iteration.
 *
 * Budgets follow OpenClaw's `bootstrapMaxChars` (20k per file) plus the sum cap
 * the plan calls for, which OpenClaw lacks and which is the one that actually
 * bounds a deep stack.
 */

/**
 * Per-file ceiling before the tail is trimmed.
 *
 * **Deliberately above the plan's cited 20,000, and the measurement is why.**
 * OpenClaw's `bootstrapMaxChars` is 20k, but this machine's own user-global
 * `CLAUDE.md` is 23,752 characters, so a 20k cap would trim its last ~3.7 KB —
 * which is exactly where Completion Standards, the Completion Fresh-Eyes Gate
 * and the Completed-Files rules sit. Silently deleting the rule that requires
 * independent verification, to save ~940 tokens, is a bad trade.
 *
 * Importance is not ordered by position in an instruction file, so ANY tail
 * truncation can drop a load-bearing rule. This is therefore a guardrail against
 * pathological growth, not a routine trimmer: it should not fire on a healthy
 * stack, and when it does fire it names the file so a human slims it properly.
 */
export const INSTRUCTION_FILE_MAX_CHARS = 32_000;

/**
 * Ceiling across the whole joined stack. The plan cites 60,000; this machine's
 * real stack is 35,456, so 60k would leave under 2× headroom before a routine
 * addition started silently dropping whole files. 96k (~24k tokens of
 * instructions on every fresh spawn) is still unambiguously pathological.
 */
export const INSTRUCTION_STACK_MAX_CHARS = 96_000;

export interface CapInstructionOptions {
  fileMaxChars?: number;
  stackMaxChars?: number;
}

export interface CappedInstructions {
  /** The parts to inject, in the original order. */
  parts: string[];
  /** Labels whose content was trimmed, in order. Empty when nothing was cut. */
  trimmed: string[];
  /** Labels dropped whole because the stack budget was already spent. */
  dropped: string[];
}

/**
 * Cut to `max` characters on a line boundary where one exists in the kept
 * region, so a trimmed file does not end mid-sentence. Falls back to a hard cut
 * rather than keeping more than the budget.
 */
function cutAtLineBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastBreak = head.lastIndexOf('\n');
  // Only honour a line break in the last quarter, or a file whose first line is
  // enormous would collapse to almost nothing.
  return lastBreak > max * 0.75 ? head.slice(0, lastBreak) : head;
}

/**
 * A notice the reader can act on. nanoclaw's lesson: say the file is trimmed and
 * what to do, rather than cutting silently. Named per file so the operator knows
 * which one to slim.
 */
function trimNotice(label: string, max: number): string {
  return `\n\n... (truncated: ${label} is over the ${max.toLocaleString('en-US')}-character `
    + 'instruction budget for a fresh session — slim this file)';
}

function dropNotice(labels: readonly string[], max: number): string {
  const list = labels.join(', ');
  return `\n\n... (omitted entirely: ${list} — the instruction stack is over its `
    + `${max.toLocaleString('en-US')}-character budget for a fresh session)`;
}

/**
 * Apply the per-file and whole-stack budgets.
 *
 * `labels[i]` names `parts[i]` for the notice text; a missing label falls back
 * to a positional name so the output stays deterministic and the function never
 * throws on a mismatched pairing.
 */
export function capInstructionPrompts(
  parts: readonly string[],
  labels: readonly string[] = [],
  options: CapInstructionOptions = {},
): CappedInstructions {
  const fileMax = options.fileMaxChars ?? INSTRUCTION_FILE_MAX_CHARS;
  const stackMax = options.stackMaxChars ?? INSTRUCTION_STACK_MAX_CHARS;

  const kept: string[] = [];
  const trimmed: string[] = [];
  const dropped: string[] = [];
  let spent = 0;

  for (let i = 0; i < parts.length; i += 1) {
    const label = labels[i] ?? `instruction file ${i + 1}`;
    const original = parts[i] ?? '';

    if (spent >= stackMax) {
      dropped.push(label);
      continue;
    }

    // The tighter of the two budgets wins for this part.
    const budget = Math.min(fileMax, stackMax - spent);
    let text = original;
    if (text.length > budget) {
      text = cutAtLineBoundary(text, budget) + trimNotice(label, budget);
      trimmed.push(label);
    }

    kept.push(text);
    spent += original.length > budget ? budget : original.length;
  }

  if (dropped.length > 0 && kept.length > 0) {
    kept[kept.length - 1] += dropNotice(dropped, stackMax);
  }

  return { parts: kept, trimmed, dropped };
}

/** The shape this needs from `resolveInstructionStack()`'s result. */
export interface CappableInstructionResolution {
  mergedContent: string;
  sources: readonly { loaded: boolean; applied: boolean; label: string; path: string }[];
}

/**
 * Split a resolved stack back into its parts, pair them with the sources the
 * resolver actually merged, and apply the budgets.
 *
 * Kept here rather than inline at the call site so the split-and-pair step is
 * testable against a real resolution: the pairing is positional, and a file
 * whose own body contains the `\n\n---\n\n` separator would desynchronise it.
 * That is why the labels are advisory — `capInstructionPrompts` falls back to a
 * positional name rather than mislabelling a file in operator-facing text.
 */
export function capResolvedInstructionStack(
  resolution: CappableInstructionResolution,
  options: CapInstructionOptions = {},
): CappedInstructions {
  if (!resolution.mergedContent) return { parts: [], trimmed: [], dropped: [] };
  const parts = resolution.mergedContent.split('\n\n---\n\n');
  const labels = resolution.sources
    .filter((source) => source.loaded && source.applied)
    .map((source) => source.label || source.path);
  return capInstructionPrompts(parts, labels, options);
}
