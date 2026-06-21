// ============ Outstanding items ============
//
// Split out of loop.types.ts to keep that file under its LOC ceiling. These
// types describe the structured capture of a loop's OUTSTANDING.md (the work
// the agent could not resolve autonomously) so it can be persisted, exported,
// and surfaced in the originating session instead of being lost in the hidden
// per-run state dir.

import type { LoopStatus } from './loop.types';

/**
 * One parsed OUTSTANDING.md bullet plus the agent's optional recommended
 * decision/next-step for it (a `Recommendation:` sub-bullet the agent writes
 * under the item). The recommendation pre-fills the answer box in the
 * Outstanding panel so the human starts from a concrete suggestion instead of a
 * blank field — it is a *suggestion only*, never auto-accepted as the answer.
 */
export interface LoopOutstandingEntry {
  /** The bullet text (the work item / question itself). */
  text: string;
  /** The agent's one-line recommended decision/next step, or null when none. */
  recommendation: string | null;
}

/**
 * Structured snapshot of a loop's OUTSTANDING.md, parsed at termination. The
 * agent maintains OUTSTANDING.md with work it could NOT resolve autonomously
 * (items needing a human) and unresolved questions.
 */
export interface LoopOutstanding {
  /** Items under the "Needs human" / "Manual verification" sections. */
  needsHuman: LoopOutstandingEntry[];
  /** Items under the "Open questions" section. */
  openQuestions: LoopOutstandingEntry[];
  /** Raw OUTSTANDING.md text (for export / inspection). */
  raw: string;
  /** Epoch ms when this snapshot was captured. */
  capturedAt: number;
}

/** Resolution state of a single aggregated outstanding item. */
export type LoopOutstandingItemStatus = 'open' | 'resolved' | 'dismissed';

/** Which OUTSTANDING.md section an aggregated item came from. */
export type LoopOutstandingItemKind = 'needs-human' | 'open-question';

/**
 * One aggregated, persisted outstanding item across loop runs. Stored in
 * `loop_outstanding_items` and surfaced in the originating session's
 * Outstanding panel so human-gated work survives the chat scroll-back and can
 * be marked resolved / dismissed.
 */
export interface LoopOutstandingItem {
  /** Stable id = sha256(loopRunId|kind|text). Lets re-captures dedupe + keep status. */
  id: string;
  loopRunId: string;
  chatId: string;
  /** Workspace the loop ran in — retained for export and optional filtering. */
  workspaceCwd: string;
  kind: LoopOutstandingItemKind;
  text: string;
  /**
   * The human's recorded decision/answer for this item, or null when none has
   * been entered yet. Preserved across resolve/dismiss/reopen status changes so
   * the rationale survives, and surfaced in the panel + exported OUTSTANDING.md.
   */
  userResponse: string | null;
  /**
   * The agent's recommended decision/answer for this item (parsed from the
   * `Recommendation:` sub-bullet in OUTSTANDING.md), or null when the agent gave
   * none. Pre-fills the answer box as an editable suggestion; it is NOT counted
   * as an answer until the human saves/accepts it, so the human gate stays real.
   */
  recommendedAnswer: string | null;
  status: LoopOutstandingItemStatus;
  /** The run's terminal status, for context in the panel (e.g. completed-needs-review). */
  loopStatus: LoopStatus;
  /** Epoch ms when first captured. */
  createdAt: number;
  /** Epoch ms of the last status change / re-capture. */
  updatedAt: number;
  /** Epoch ms when marked resolved/dismissed, else null. */
  resolvedAt: number | null;
}
