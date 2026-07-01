/**
 * Start-time ledger lint — flag structurally unclosable open items.
 *
 * The completion gate stops a review-driven loop only when EVERY `LOOP_TASKS.md`
 * item is `[x]` (done) or `[-]` (deferred). An OPEN (`[ ]`/`[~]`) item whose text
 * is open-ended ("continue remaining slices…") or gated on unavailable
 * hardware / manual action ("until a real microphone is available") can never
 * become `[x]` in a headless loop, so it blocks completion forever.
 *
 * Observed: loop-1782864004679 stalled on exactly these two item shapes — an
 * open-ended "Continue remaining Loop Engine slices: A0-A3, B2-B6…" bucket and a
 * "STT Phase 6 … hardware smoke evidence … until a real worker/microphone test
 * is available" item, both left as `[ ]`.
 *
 * This lint runs once at loop start so the coordinator can warn the operator
 * (and surface the finding to the agent) that the ledger is non-convergent as
 * written: those items should be split into finite, closable slices or deferred
 * with a reason up front. It never blocks the loop — it is advisory.
 *
 * Pure module — no I/O.
 */

import type { LoopTaskItem, LoopTaskLedger } from './loop-task-ledger';

export type LedgerLintCategory = 'open-ended' | 'external-gated';

export interface LedgerLintFinding {
  /** The offending item's text. */
  item: string;
  category: LedgerLintCategory;
  /** Why the item can't reach `[x]` in a headless loop. */
  reason: string;
}

// Open-ended scope: a bucket that always has a "next", so it never reaches [x].
const OPEN_ENDED: RegExp[] = [
  /\bcontinue\b[^.]*\b(remaining|rest|other|others)\b/i,
  /\bremaining\b[^.]*\b(slices?|items?|work|tasks?|phases?|steps?)\b/i,
  /\band\s+(the\s+)?(gated|other|rest)\b[^.]*\bwork\b/i,
  /\b(etc\.?|and\s+so\s+on|and\s+more|and\s+others)\b/i,
  /\bongoing\b/i,
];

// Gated on something a headless loop can't produce (hardware / manual / human).
const EXTERNAL_GATED: RegExp[] = [
  /\buntil\b[^.]*\b(available|works?|ready|provided|possible|exists?)\b/i,
  /\b(hardware|microphone|physical\s+device)\b/i,
  /\breal\s+(worker|device|node|microphone|hardware|user)\b/i,
  /\b(manual|operator|human)[\s-]*(smoke|test|testing|review|decision|verification|sign[\s-]*off)\b/i,
  /\brequires?\s+a\s+(human|person|operator|real\b)/i,
];

function matchAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

/** Lint a single ledger item. Returns `null` when it's closable or not open. */
export function lintLedgerItem(item: LoopTaskItem): LedgerLintFinding | null {
  if (item.state !== 'todo' && item.state !== 'doing') return null;
  if (matchAny(item.text, OPEN_ENDED)) {
    return {
      item: item.text,
      category: 'open-ended',
      reason:
        'open-ended scope — always has a "next" item, so it can never be marked [x]; ' +
        'split it into a finite list of concrete slices or defer the remainder with a reason',
    };
  }
  if (matchAny(item.text, EXTERNAL_GATED)) {
    return {
      item: item.text,
      category: 'external-gated',
      reason:
        'gated on hardware / manual / operator action a headless loop cannot produce; ' +
        'mark it [-] deferred with the gating reason instead of leaving it open',
    };
  }
  return null;
}

/** Lint the whole ledger. Empty array = no unclosable open items found. */
export function lintTaskLedger(ledger: LoopTaskLedger): LedgerLintFinding[] {
  const out: LedgerLintFinding[] = [];
  for (const item of ledger.items) {
    const finding = lintLedgerItem(item);
    if (finding) out.push(finding);
  }
  return out;
}
