// ============ Outstanding items ============
//
// Split out of loop.types.ts to keep that file under its LOC ceiling. These
// types describe the structured capture of a loop's OUTSTANDING.md (the work
// the agent could not resolve autonomously) so it can be persisted, exported,
// and surfaced in the originating session instead of being lost in the hidden
// per-run state dir.

import type { LoopStatus } from './loop.types';

/**
 * Structured snapshot of a loop's OUTSTANDING.md, parsed at termination. The
 * agent maintains OUTSTANDING.md with work it could NOT resolve autonomously
 * (items needing a human) and unresolved questions.
 */
export interface LoopOutstanding {
  /** Items under the "Needs human" / "Manual verification" sections. */
  needsHuman: string[];
  /** Items under the "Open questions" section. */
  openQuestions: string[];
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
