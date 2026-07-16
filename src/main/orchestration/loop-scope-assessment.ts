/**
 * WS7 (loop-convergence plan) — pure plan-scope assessment.
 *
 * A single review-driven loop cannot faithfully execute a plan that its own
 * text forbids running in one pass (e.g. the Fable plan's "one workstream per
 * run") or that spans many workstreams — the observed failure is a ledger that
 * never converges. This assessor classifies a configured plan BEFORE the loop
 * starts, deterministically and conservatively:
 *
 *   - `campaign-required`    an explicit one-workstream constraint coexists
 *                            with ≥2 extracted workstreams — the main-process
 *                            guard refuses to start a single loop;
 *   - `campaign-recommended` multiple workstreams or an oversized leaf
 *                            checklist, with no explicit prohibition — the
 *                            renderer presents the reason and the user may
 *                            deliberately override to a single loop;
 *   - `single-loop`          everything else.
 *
 * NO LLM sees the plan text for this gate: a false negative merely surfaces a
 * recommendation later, while a false positive must never silently rewrite
 * execution. Parsing is code-fence aware so example headings inside ``` blocks
 * are ignored. Pure module — no I/O.
 */

import { parseTaskLedger } from './loop-task-ledger';

export type LoopScopeDisposition = 'single-loop' | 'campaign-recommended' | 'campaign-required';
export type LoopScopeReason =
  | 'explicit-one-workstream-rule'
  | 'multiple-workstreams'
  | 'oversized-checklist';

export interface LoopScopeWorkstream {
  id: string;
  title: string;
  /** 1-indexed, inclusive. */
  startLine: number;
  endLine: number;
}

export interface LoopScopeAssessment {
  disposition: LoopScopeDisposition;
  reasons: LoopScopeReason[];
  workstreams: LoopScopeWorkstream[];
  checklistLeafCount: number;
}

/**
 * Leaf-checklist size beyond which a plan is too large for one loop's
 * convergence budget. Deterministic constant: at the WS6 default of 30
 * turns/iteration and the stall limit of 8 no-transition iterations, a plan
 * with >40 leaves has historically outrun the ledger before converging.
 */
export const OVERSIZED_CHECKLIST_LEAF_COUNT = 40;

/** `## WS4 — Title` / `### WS4: Title` / `## Workstream 4 — Title` (h2/h3). */
const WORKSTREAM_HEADING = /^#{2,3}\s+(?:WS\s?(\d+)|Workstream\s+(\d+))\s*(?:[—:–-]\s*(.*))?\s*$/i;

/** Explicit "one workstream per run"-class constraints. */
const ONE_WORKSTREAM_RULES: RegExp[] = [
  /\bone\s+workstream\s+per\s+(?:run|loop|iteration|session)\b/i,
  /\bdo\s+not\s+(?:start|begin|open|attempt)\s+(?:a\s+)?(?:second|another|more\s+than\s+one)\s+workstream/i,
  /\bonly\s+one\s+workstream\s+(?:at\s+a\s+time|per\s+run)\b/i,
  /\bimplement\s+one\s+(?:workstream|ws)\s+per\s+run\b/i,
];

/** Split into lines with an in-code-fence mask (``` and ~~~ fences). */
function maskedLines(text: string): { line: string; inFence: boolean }[] {
  const out: { line: string; inFence: boolean }[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const open = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      out.push({ line, inFence: true });
      if (open && open[1].startsWith(fence[0]) && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      out.push({ line, inFence: true });
      continue;
    }
    out.push({ line, inFence: false });
  }
  return out;
}

/** Assess a plan document. Deterministic; retains line ranges, never the body. */
export function assessLoopScope(planText: string): LoopScopeAssessment {
  const lines = maskedLines(planText);

  // Extract workstream headings (outside code fences), deduplicating repeated
  // ids conservatively: a duplicate heading id extends nothing and is counted
  // once — malformed ordering must not inflate the workstream count.
  const workstreams: LoopScopeWorkstream[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const { line, inFence } = lines[i];
    if (inFence) continue;
    const m = WORKSTREAM_HEADING.exec(line);
    if (!m) continue;
    const id = `WS${m[1] ?? m[2]}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    workstreams.push({
      id,
      title: (m[3] ?? '').trim(),
      startLine: i + 1,
      endLine: lines.length, // provisional; tightened below
    });
  }
  for (let w = 0; w < workstreams.length - 1; w++) {
    workstreams[w].endLine = workstreams[w + 1].startLine - 1;
  }

  // Explicit one-workstream constraint, outside code fences.
  const prose = lines.filter((l) => !l.inFence).map((l) => l.line).join('\n');
  const hasOneWorkstreamRule = ONE_WORKSTREAM_RULES.some((re) => re.test(prose));

  // Leaf checklist size, code-fence masked (the ledger grammar is a superset
  // of plan checklists; leaves exclude structural parent rows).
  const checklistLeafCount = parseTaskLedger(
    lines.map((l) => (l.inFence ? '' : l.line)).join('\n'),
  ).total;

  const reasons: LoopScopeReason[] = [];
  if (hasOneWorkstreamRule && workstreams.length >= 2) reasons.push('explicit-one-workstream-rule');
  if (workstreams.length >= 2) reasons.push('multiple-workstreams');
  if (checklistLeafCount > OVERSIZED_CHECKLIST_LEAF_COUNT) reasons.push('oversized-checklist');

  const disposition: LoopScopeDisposition =
    hasOneWorkstreamRule && workstreams.length >= 2
      ? 'campaign-required'
      : reasons.length > 0
        ? 'campaign-recommended'
        : 'single-loop';

  return { disposition, reasons, workstreams, checklistLeafCount };
}
