/**
 * L4 — intra-iteration phase, inferred from the command stream.
 *
 * The HUD can say which iteration is running and which loop *stage* the state
 * machine thinks it is in, but not what the child is doing right now. "Running
 * iteration 12, stage IMPLEMENT" reads the same whether the agent is grepping,
 * editing, or sitting inside a ten-minute test run, which is exactly the
 * ambiguity that makes a slow build look like a stall.
 *
 * This is a pure regex classifier over the activity the adapter already emits
 * (codex-plugin-cc `inferLegacyJobPhase`). Zero model calls, zero new events.
 * It is advisory: the HUD may show it, and L3's health reducer may hold its
 * stall counters while the phase is `verifying`, but nothing terminal keys off
 * it. An unrecognised tool returns `null` rather than guessing.
 */

import type { LoopInferredPhase } from '../../shared/types/loop-health.types';

export type { LoopInferredPhase };

export interface LoopPhaseActivityLike {
  kind: string;
  message: string;
  detail?: Record<string, unknown>;
}

/** Read-only inspection tools. */
const INVESTIGATING_TOOLS = /^(read|grep|glob|ls|list|search|webfetch|websearch|notebookread|codemem_.*|lsp_.*|find_symbol|find_references)$/i;
/** Anything that mutates the workspace. */
const EDITING_TOOLS = /^(edit|write|multiedit|notebookedit|applypatch|apply_patch|str_replace.*|create_file)$/i;
/** Sub-agent / review dispatch. */
const REVIEWING_TOOLS = /^(task|agent|review.*|dispatch_agent)$/i;

/**
 * Shell commands that mean "a check is running". Deliberately narrow: a `git
 * status` or an `ls` in Bash is investigation, not verification, and calling it
 * verification would let L3 hold a stall counter open on a no-op.
 */
const VERIFYING_COMMAND = new RegExp(
  [
    '\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?(test|verify|lint|typecheck|build|check)',
    '\\bnpx\\s+(tsc|vitest|jest|eslint|oxlint|playwright)',
    '\\b(vitest|jest|pytest|go\\s+test|cargo\\s+(test|build|clippy)|mvn|gradle)\\b',
    '\\btsc\\b',
    '\\bmake\\s+(test|check|build)',
  ].join('|'),
  'i',
);

/** Shell commands that are plainly read-only inspection. */
const INVESTIGATING_COMMAND = /\b(git\s+(status|log|diff|show|branch)|rg|grep|find|ls|cat|head|tail|wc|which)\b/i;

function toolNameOf(activity: LoopPhaseActivityLike): string {
  const fromDetail = activity.detail?.['toolName'] ?? activity.detail?.['name'] ?? activity.detail?.['tool'];
  if (typeof fromDetail === 'string' && fromDetail.trim()) return fromDetail.trim();
  // The rendered message is typically `Tool: Bash` / `Bash(npm run verify)`.
  const match = /^(?:tool:\s*)?([A-Za-z_][\w.-]*)/.exec(activity.message.trim());
  return match?.[1] ?? '';
}

function commandTextOf(activity: LoopPhaseActivityLike): string {
  const fromDetail = activity.detail?.['command'] ?? activity.detail?.['cmd'] ?? activity.detail?.['input'];
  if (typeof fromDetail === 'string' && fromDetail.trim()) return fromDetail;
  return activity.message;
}

/**
 * Classify one activity event. `null` means "this event says nothing about the
 * phase" — the caller keeps whatever phase it already had.
 */
export function inferLoopPhase(activity: LoopPhaseActivityLike): LoopInferredPhase | null {
  if (activity.kind !== 'tool_use') return null;

  const tool = toolNameOf(activity);
  if (EDITING_TOOLS.test(tool)) return 'editing';
  if (REVIEWING_TOOLS.test(tool)) return 'reviewing';
  if (INVESTIGATING_TOOLS.test(tool)) return 'investigating';

  // Bash and friends carry the real signal in the command text.
  const command = commandTextOf(activity);
  if (VERIFYING_COMMAND.test(command)) return 'verifying';
  if (INVESTIGATING_COMMAND.test(command)) return 'investigating';
  return null;
}

/** Human-facing label for the HUD. */
export function loopPhaseLabel(phase: LoopInferredPhase): string {
  switch (phase) {
    case 'investigating': return 'investigating';
    case 'editing': return 'editing';
    case 'verifying': return 'running checks';
    case 'reviewing': return 'reviewing';
  }
}
