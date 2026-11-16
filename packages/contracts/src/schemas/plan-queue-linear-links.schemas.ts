/**
 * Plan Queue schemas for the folder-link channels: reading Linear's teams and projects for the editor, reading the
 * saved links with each one's live state, and saving the whole list. Re-exported from `plan-queue.schemas.ts`, so
 * callers import them from `@contracts/schemas/plan-queue`.
 *
 * Every refusal reason is fixed words written by Harness plus a folder path or a project name. Nothing Linear returned
 * is used as a sentence. Project and team names are shown as plain text and never placed in a prompt.
 */
import { z } from 'zod';
import type { PlanQueueLinearFolderLink, PlanQueueLinearProject } from './plan-queue-linear.schemas';

/**
 * Save: the whole list as the editor holds it. Rows are checked one by one in the main process, so a malformed row
 * is refused with its own reason instead of failing the whole request, and the list can be at most 100 rows.
 */
export const PlanQueueLinearLinksSavePayloadSchema = z.object({ links: z.array(z.unknown()).max(101) }).strict();
export type PlanQueueLinearLinksSavePayload = z.infer<typeof PlanQueueLinearLinksSavePayloadSchema>;

/** The Linear projects a team holds, as offered in the editor's pickers. Names only; no ticket is read. */
export interface PlanQueueLinearTeamProjects {
  teamId: string;
  teamKey: string;
  teamName: string;
  projects: Array<{ id: string; name: string }>;
}

export interface PlanQueueLinearProjectChoices {
  teams: PlanQueueLinearTeamProjects[];
}

/** One saved link and, when its folder can no longer be used, the plain reason. A broken link is not used. */
export interface PlanQueueLinearLinkReading {
  link: PlanQueueLinearFolderLink;
  broken: string | null;
}

export interface PlanQueueLinearLinksReading {
  links: PlanQueueLinearLinkReading[];
}

/** Why one row of a save was refused. `index` is null for a reason about the whole list. */
export interface PlanQueueLinearLinkRefusal {
  index: number | null;
  reason: string;
}

/** A save either stores the whole list or nothing, and says why for every refused row. */
export type PlanQueueLinearLinksSaveResult =
  | { saved: true; links: PlanQueueLinearFolderLink[] }
  | { saved: false; refused: PlanQueueLinearLinkRefusal[] };

/** What a later step asks of a folder: its linked projects, a broken link with its reason, or no link. */
export type PlanQueueLinearFolderReading =
  | { status: 'none'; folder: string }
  | { status: 'broken'; folder: string; reason: string }
  | {
      status: 'linked';
      folder: string;
      privateProject: PlanQueueLinearProject | null;
      clientProjects: PlanQueueLinearProject[];
    };
