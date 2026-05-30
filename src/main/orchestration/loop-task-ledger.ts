/**
 * LF-4 (loopfixex.md) — structured task ledger (`LOOP_TASKS.md`).
 *
 * Stage progression and completion were forensic: the agent rewrote STAGE.md
 * and the loop guessed "done" from file renames / DONE.txt / a 100%-ticked plan
 * checklist, with no per-item ground truth. The ledger makes the *items* the
 * source of truth for stopping: a multi-item goal stops only when every item is
 * `done` or `deferred(reason)` — and an explicitly deferred item (with a reason)
 * does not block the stop. File-rename / DONE.txt stay as corroboration.
 *
 * Format (human-readable + agent-editable markdown checkboxes, parsed with the
 * same checkbox grammar as `parsePlanChecklist`):
 *   - [ ] todo item
 *   - [~] item in progress (doing)
 *   - [x] completed item            (also [X])
 *   - [-] deferred item — deferred: not needed for v1   (also [>])
 *
 * Deferred reason: trailing `deferred: <reason>` or `(deferred: <reason>)`, or
 * any `— <reason>` after the text. Pure module — no I/O — so it's trivially
 * unit-tested and shared between the completion detector and the stage machine.
 */

export type LoopTaskState = 'todo' | 'doing' | 'done' | 'deferred';

export interface LoopTaskItem {
  /** The task description (marker + reason suffix stripped). */
  text: string;
  state: LoopTaskState;
  /** Reason captured for deferred items (empty when none / not deferred). */
  reason: string;
}

export interface LoopTaskLedger {
  items: LoopTaskItem[];
  total: number;
  /** Count of items that are `done` or `deferred`. */
  resolved: number;
  /** True iff there is ≥1 item and every item is resolved (done/deferred). */
  complete: boolean;
  /** The first unresolved item's text (the agent's next task), or null. */
  nextTodo: string | null;
}

const LEDGER_LINE = /^\s*[-*]\s*\[([- xX~>])\]\s*(.*)$/;

function classifyMarker(marker: string): LoopTaskState {
  switch (marker) {
    case 'x':
    case 'X':
      return 'done';
    case '~':
      return 'doing';
    case '-':
    case '>':
      return 'deferred';
    default:
      return 'todo';
  }
}

function extractDeferredReason(text: string): { text: string; reason: string } {
  // `deferred: reason` / `(deferred: reason)` / trailing `— reason`.
  const explicit = text.match(/\(?\s*deferred\s*:\s*(.+?)\s*\)?\s*$/i);
  if (explicit) {
    return { text: text.slice(0, explicit.index).replace(/[—\-–:\s]+$/, '').trim(), reason: explicit[1].trim() };
  }
  const dash = text.match(/\s+[—–]\s+(.+?)\s*$/);
  if (dash) {
    return { text: text.slice(0, dash.index).trim(), reason: dash[1].trim() };
  }
  return { text: text.trim(), reason: '' };
}

/**
 * Parse `LOOP_TASKS.md` content into a structured ledger. Non-checkbox lines
 * (headings, prose) are ignored. Returns an empty ledger (`complete: false`,
 * `total: 0`) when there are no checkbox items, so an empty/absent ledger never
 * reads as "complete".
 */
export function parseTaskLedger(text: string): LoopTaskLedger {
  const items: LoopTaskItem[] = [];
  // Strip HTML comment blocks first so commented-out examples / templates
  // (e.g. the bootstrap `<!-- - [ ] example -->`) are never counted as items.
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
  for (const line of withoutComments.split(/\r?\n/)) {
    const m = LEDGER_LINE.exec(line);
    if (!m) continue;
    const state = classifyMarker(m[1]);
    const rawText = m[2] ?? '';
    if (state === 'deferred') {
      const { text: cleaned, reason } = extractDeferredReason(rawText);
      items.push({ text: cleaned || rawText.trim(), state, reason });
    } else {
      items.push({ text: rawText.trim(), state, reason: '' });
    }
  }
  const total = items.length;
  const resolved = items.filter((i) => i.state === 'done' || i.state === 'deferred').length;
  const nextTodo = items.find((i) => i.state === 'todo' || i.state === 'doing')?.text ?? null;
  return {
    items,
    total,
    resolved,
    complete: total > 0 && resolved === total,
    nextTodo,
  };
}

/** Serialize a ledger back to markdown (used for bootstrap / derive-from-plan). */
export function serializeTaskLedger(ledger: Pick<LoopTaskLedger, 'items'>): string {
  const marker: Record<LoopTaskState, string> = { todo: ' ', doing: '~', done: 'x', deferred: '-' };
  const lines = ledger.items.map((item) => {
    const suffix = item.state === 'deferred' && item.reason ? ` — deferred: ${item.reason}` : '';
    return `- [${marker[item.state]}] ${item.text}${suffix}`;
  });
  return ['# Loop Tasks', '', 'Structured task ledger. The loop stops when every item is `[x]` (done) or', '`[-]` (deferred, with a reason). `[~]` marks an item in progress.', '', ...lines, ''].join('\n');
}

/**
 * Derive a ledger from an existing plan-file checklist (back-compat): each
 * `[ ]`/`[x]` plan item becomes a ledger item. Used when a loop has a plan file
 * but no `LOOP_TASKS.md` yet, so legacy plan-file loops still get item-level
 * stopping without the agent rewriting anything.
 */
export function deriveLedgerFromChecklist(planText: string): LoopTaskLedger {
  // Reuse the ledger grammar — plan checkboxes are a subset of it.
  return parseTaskLedger(planText);
}
