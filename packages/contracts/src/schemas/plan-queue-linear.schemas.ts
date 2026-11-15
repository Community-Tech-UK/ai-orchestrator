/**
 * Plan Queue schemas for James's saved Linear settings: which Harness connector is Linear's and who he is on it
 * (`planQueueLinearConnection`), which Linear projects belong to which project folder
 * (`planQueueLinearFolderLinks`), and each team's status mapping and the providers allowed to see its ticket text
 * (`planQueueLinearTeams`). All three are operator-only. Re-exported from `plan-queue.schemas.ts`, so callers import
 * them from `@contracts/schemas/plan-queue`.
 *
 * These schemas check shape only. Whether a status, team or project still exists in Linear is checked live and shown
 * on its row, so an out-of-date entry can still be opened and corrected, and one bad saved entry never blocks a save.
 */
import { z } from 'zod';
import { isAbsoluteChecklistFolder, normalizeChecklistFolder } from './plan-queue-folders.schemas';

/** A name Linear gave, shown as plain text and never placed in a prompt. */
const LinearNameSchema = z.string().trim().min(1).max(200);
const LinearIdSchema = z.string().trim().min(1).max(200);

/**
 * James's confirmed Linear connection: the Harness connector Linear is reached through, and the user the connector
 * signed in as. One record, so the user id can never be saved against a different connector than the one it was
 * read from. `null` means not set up.
 */
export const PlanQueueLinearConnectionSchema = z.object({
  connectorId: LinearIdSchema,
  userId: LinearIdSchema,
  userName: LinearNameSchema,
  workspaceName: LinearNameSchema,
  /** Unix milliseconds when James confirmed on the Plan Queue page that this is him. */
  confirmedAt: z.number().int().positive(),
}).strict().nullable();

export const DEFAULT_PLAN_QUEUE_LINEAR_CONNECTION: PlanQueueLinearConnection = null;

/** A Linear project as it looked when James saved the link: its id, plus the names shown on the page. */
export const PlanQueueLinearProjectSchema = z.object({
  id: LinearIdSchema,
  name: LinearNameSchema,
  teamId: LinearIdSchema,
  teamKey: z.string().trim().min(1).max(20),
}).strict();

/**
 * One project folder and the Linear projects it serves: an optional private project of James's and a list of client
 * projects. A folder is a full path; an entry names at least one project.
 */
export const PlanQueueLinearFolderLinkSchema = z.object({
  folder: z.string().trim().min(1).max(1000).refine(isAbsoluteChecklistFolder, {
    message: 'Give the full path of the folder, starting with / or a drive letter such as C:\\.',
  }),
  privateProject: PlanQueueLinearProjectSchema.nullable(),
  clientProjects: z.array(PlanQueueLinearProjectSchema).max(20),
}).strict().refine((link) => link.privateProject !== null || link.clientProjects.length > 0, {
  message: 'Link at least one Linear project to the folder.',
});

export const PlanQueueLinearFolderLinksSchema = z.array(PlanQueueLinearFolderLinkSchema).max(100).superRefine((links, ctx) => {
  const folders = new Set<string>();
  const projects = new Set<string>();
  links.forEach((link, index) => {
    const folder = normalizeChecklistFolder(link.folder);
    if (folders.has(folder)) {
      ctx.addIssue({ code: 'custom', path: [index, 'folder'], message: 'Each folder can be linked once.' });
    }
    folders.add(folder);
    const linked = link.privateProject ? [link.privateProject, ...link.clientProjects] : link.clientProjects;
    for (const project of linked) {
      if (projects.has(project.id)) {
        ctx.addIssue({ code: 'custom', path: [index], message: `The Linear project "${project.name}" can be linked to one folder only.` });
      }
      projects.add(project.id);
    }
  });
});

export const DEFAULT_PLAN_QUEUE_LINEAR_FOLDER_LINKS: PlanQueueLinearFolderLink[] = [];

/** A Linear workflow status as Linear gave it. `kind` is Linear's own type word (`started`, `unstarted`, and so on). */
export const PlanQueueLinearStatusSchema = z.object({
  id: LinearIdSchema,
  name: LinearNameSchema,
  kind: z.string().trim().min(1).max(50),
}).strict();

/**
 * One Linear team's rules: whether it is James's own team or a client team, the status Harness sets when work starts,
 * when it hands a ticket back, and when the code lands (and the done status, for James's own teams only), and the
 * providers allowed to see this team's ticket text. An empty provider list is valid and means no provider.
 */
export const PlanQueueLinearTeamSchema = z.object({
  teamId: LinearIdSchema,
  teamKey: z.string().trim().min(1).max(20),
  teamName: LinearNameSchema,
  ownership: z.enum(['own', 'client']),
  startedStatus: PlanQueueLinearStatusSchema,
  handBackStatus: PlanQueueLinearStatusSchema,
  landedStatus: PlanQueueLinearStatusSchema,
  /** Set for James's own teams only: a client team has no done status, because Harness never closes client work. */
  doneStatus: PlanQueueLinearStatusSchema.nullable(),
  providers: z.array(z.string().trim().min(1).max(50)).max(20),
}).strict().superRefine((team, ctx) => {
  if (team.startedStatus.kind !== 'started') {
    ctx.addIssue({ code: 'custom', path: ['startedStatus'], message: 'The status for work that has started must be of the started kind.' });
  }
  if (team.landedStatus.kind !== 'started') {
    ctx.addIssue({ code: 'custom', path: ['landedStatus'], message: 'The status for landed code must be of the started kind, so a landed ticket never counts as done.' });
  }
  if (team.handBackStatus.kind !== 'unstarted') {
    ctx.addIssue({ code: 'custom', path: ['handBackStatus'], message: 'The status for a ticket handed back must be of the unstarted kind.' });
  }
  if (team.ownership === 'client' && team.doneStatus !== null) {
    ctx.addIssue({ code: 'custom', path: ['doneStatus'], message: 'A client team has no done status: a person moves a client ticket to Done.' });
  }
  if (team.ownership === 'own' && team.doneStatus === null) {
    ctx.addIssue({ code: 'custom', path: ['doneStatus'], message: 'Choose the done status for your own team.' });
  }
  if (team.doneStatus !== null && team.doneStatus.kind !== 'completed') {
    ctx.addIssue({ code: 'custom', path: ['doneStatus'], message: 'The done status must be of the completed kind.' });
  }
  if (new Set(team.providers).size !== team.providers.length) {
    ctx.addIssue({ code: 'custom', path: ['providers'], message: 'List each provider once.' });
  }
});

export const PlanQueueLinearTeamsSchema = z.array(PlanQueueLinearTeamSchema).max(50).superRefine((teams, ctx) => {
  const seen = new Set<string>();
  teams.forEach((team, index) => {
    if (seen.has(team.teamId)) {
      ctx.addIssue({ code: 'custom', path: [index, 'teamId'], message: 'Each team can have one set of rules.' });
    }
    seen.add(team.teamId);
  });
});

export const DEFAULT_PLAN_QUEUE_LINEAR_TEAMS: PlanQueueLinearTeam[] = [];

export type PlanQueueLinearConnection = z.infer<typeof PlanQueueLinearConnectionSchema>;
export type PlanQueueLinearProject = z.infer<typeof PlanQueueLinearProjectSchema>;
export type PlanQueueLinearFolderLink = z.infer<typeof PlanQueueLinearFolderLinkSchema>;
export type PlanQueueLinearStatus = z.infer<typeof PlanQueueLinearStatusSchema>;
export type PlanQueueLinearTeam = z.infer<typeof PlanQueueLinearTeamSchema>;
