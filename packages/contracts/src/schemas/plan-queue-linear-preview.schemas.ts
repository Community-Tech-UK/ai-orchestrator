/**
 * Plan Queue schemas for the Start preview's two channels: load the list of tickets for a folder, and load one
 * ticket's description and comments. Re-exported from `plan-queue.schemas.ts`, so callers import them from
 * `@contracts/schemas/plan-queue`.
 *
 * Everything in a response is shown to James as plain text and never placed in a prompt, a log line, a run or an item.
 * The sentences are fixed words written by Harness; a ticket's own words (title, assignee, description, comments) are
 * other people's text and are only ever rendered as text.
 */
import { z } from 'zod';

/** Load the list for a folder. The folder is checked against James's saved links in the main process. */
export const PlanQueueLinearPreviewLoadPayloadSchema = z.object({ folder: z.string().trim().min(1).max(1000) }).strict();
export type PlanQueueLinearPreviewLoadPayload = z.infer<typeof PlanQueueLinearPreviewLoadPayloadSchema>;

/** Load one ticket's text from a preview, by the Linear id its row carries. */
export const PlanQueueLinearPreviewTextPayloadSchema = z.object({
  previewId: z.string().trim().min(1).max(100),
  linearId: z.string().trim().min(1).max(200),
}).strict();
export type PlanQueueLinearPreviewTextPayload = z.infer<typeof PlanQueueLinearPreviewTextPayloadSchema>;

/** A provider by the name the page shows, with the id the routing uses. */
export interface PlanQueueLinearPreviewProvider {
  id: string;
  label: string;
}

/** One linked project, with its team's readiness and the providers James allowed to see that team's tickets. */
export interface PlanQueueLinearPreviewProject {
  projectId: string;
  projectName: string;
  teamId: string;
  teamKey: string;
  /** Null when James has saved no rules for the team. */
  ownership: 'own' | 'client' | null;
  ready: boolean;
  /** Fixed sentences saying why the team is not ready; empty when it is. */
  reasons: string[];
  /** Empty means no provider may see this team's ticket text. */
  allowedProviders: PlanQueueLinearPreviewProvider[];
}

/** One ticket of the list, built from its basic fields only. No description and no comments. */
export interface PlanQueueLinearPreviewRow {
  /** Linear's long id: what a text request names. */
  id: string;
  /** The short address, such as `COM-123`. */
  identifier: string;
  title: string;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  assigneeName: string | null;
  labels: string[];
  teamId: string;
  projectId: string;
  /** Ticked for James: carries the "Harness" label and can be ticked. */
  ticked: boolean;
  canTick: boolean;
  /** The tickets this one is waiting for. */
  waitingFor: string[];
  /** Why it cannot be ticked; null when it can. */
  reason: string | null;
  /** What James should know about a ticket that can be ticked. */
  notes: string[];
}

export interface PlanQueueLinearPreview {
  previewId: string;
  /** Unix milliseconds. */
  loadedAt: number;
  /** Unix milliseconds after which the list is out of date and must be loaded again. */
  expiresAt: number;
  folder: string;
  projects: PlanQueueLinearPreviewProject[];
  rows: PlanQueueLinearPreviewRow[];
  /** Set when the "Harness" label cannot be relied on, so nothing is ticked. */
  labelNote: string | null;
}

export interface PlanQueueLinearPreviewComment {
  id: string;
  /** Null when Linear names no author. */
  authorName: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** Written by a bot or integration. Left out of the brief and the hash, so shown to James as such. */
  fromBot: boolean;
}

/** One ticket's text as James sees it, with the hash that pins it and whether its brief would be cut in a prompt. */
export interface PlanQueueLinearPreviewText {
  linearId: string;
  identifier: string;
  title: string;
  description: string;
  comments: PlanQueueLinearPreviewComment[];
  /** SHA-256 (lowercase hex) of the title, description and comments. */
  hash: string;
  /** True when the brief written from this text is longer than a prompt's 12,000-character data block holds. */
  overLimit: boolean;
}
