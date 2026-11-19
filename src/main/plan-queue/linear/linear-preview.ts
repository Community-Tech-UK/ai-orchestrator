/**
 * The Start preview, kept in memory only: the list of a folder's Linear tickets, and the text of each ticket James
 * opens. The Plan Queue page asks for it over two channels; no tool, command or session method reaches it.
 *
 * - Loading a folder runs Step 3's reading and returns a preview id, the linked projects with each team's readiness and
 *   allowed providers, and the rows. A new load for the folder replaces the old preview. Two loads for one folder at
 *   once make one set of calls and share the result.
 * - Loading one ticket's text reads its description and comments, keeps them with their hash against the preview, and
 *   says whether the brief written from them would be cut in a prompt. A request is answered only against the preview
 *   it names, and only if that preview is still the folder's current one when the read ends.
 * - One preview makes at most 200 connector calls, text included. Over that, the load fails and shows nothing.
 * - A preview is dropped after 30 minutes and when a run starts from it. Nothing is written to disk. The text is not
 *   logged: a load logs how many calls it made, and nothing else about it.
 */
import { randomUUID } from 'node:crypto';
import type {
  PlanQueueLinearPreview,
  PlanQueueLinearPreviewProject,
  PlanQueueLinearPreviewProvider,
  PlanQueueLinearPreviewRow,
  PlanQueueLinearPreviewText,
  PlanQueueLinearTeam,
} from '@contracts/schemas/plan-queue';
import { normalizeChecklistFolder } from '@contracts/schemas/plan-queue';
import { getLogger } from '../../logging/logger';
import { buildTicketBrief, isBriefOverLimit } from '../plan-queue-ticket-brief';
import type { ApprovedTicketText } from '../plan-queue-ticket-approved-text';
import { LINEAR_DISCOVERY_CALL_LIMIT, type FolderDiscovery } from './linear-ticket-reader';
import { approvedTextOf, type TicketTextRead } from './linear-ticket-text';
import { LinearCallCounter, isLinearCallLimitError } from './linear-tickets';

const logger = getLogger('LinearPreview');

export const LINEAR_PREVIEW_LIFETIME_MS = 30 * 60 * 1000;
export const LINEAR_PREVIEW_OUT_OF_DATE = 'This list is out of date. Load it again.';
export const LINEAR_PREVIEW_NOT_IN_LIST = 'That ticket is not in this list.';
export const LINEAR_PREVIEW_TOO_MANY = 'There are too many tickets to load at once.';

export type LinearPreviewErrorCode = 'out-of-date' | 'not-in-list' | 'call-limit';

/** A request the preview cannot answer. `message` is fixed words. */
export class LinearPreviewError extends Error {
  constructor(readonly code: LinearPreviewErrorCode, message: string) {
    super(message);
    this.name = 'LinearPreviewError';
  }
}

export function isLinearPreviewError(error: unknown): error is LinearPreviewError {
  return error instanceof LinearPreviewError;
}

export interface LinearPreviewDependencies {
  discover(folder: string, counter: LinearCallCounter): Promise<FolderDiscovery>;
  readText(identifier: string, counter: LinearCallCounter): Promise<TicketTextRead>;
  /** James's saved team rules, read live at each load. */
  readTeams(): readonly PlanQueueLinearTeam[];
  /** The name the page shows for a provider id. */
  providerLabel(id: string): string;
  now(): number;
  callLimit?: number;
  lifetimeMs?: number;
}

/** A ticket's text as James saw it, kept against its preview for the run that may start from it. */
export interface HeldTicketText {
  linearId: string;
  identifier: string;
  /** The ticket's web address, kept in the ticket table with the approved text. */
  address: string;
  title: string;
  text: ApprovedTicketText;
  hash: string;
  overLimit: boolean;
  response: PlanQueueLinearPreviewText;
}

interface PreviewEntry {
  id: string;
  folderKey: string;
  response: PlanQueueLinearPreview;
  counter: LinearCallCounter;
  rows: Map<string, PlanQueueLinearPreviewRow>;
  held: Map<string, HeldTicketText>;
  reading: Map<string, Promise<HeldTicketText>>;
  timer: ReturnType<typeof setTimeout>;
}

export class LinearPreviewService {
  private readonly byFolder = new Map<string, PreviewEntry>();
  private readonly loading = new Map<string, Promise<PlanQueueLinearPreview>>();

  constructor(private readonly deps: LinearPreviewDependencies) {}

  /** The folder's list. A load already running for the folder is shared; otherwise this one replaces the old preview. */
  load(folder: string): Promise<PlanQueueLinearPreview> {
    const key = normalizeChecklistFolder(folder);
    const running = this.loading.get(key);
    if (running) return running;
    const started = this.runLoad(folder, key).finally(() => this.loading.delete(key));
    this.loading.set(key, started);
    return started;
  }

  /** One ticket's text from a preview. The ticket must be one the preview listed. */
  async loadText(previewId: string, linearId: string): Promise<PlanQueueLinearPreviewText> {
    const entry = this.live(previewId);
    if (!entry.rows.has(linearId)) throw new LinearPreviewError('not-in-list', LINEAR_PREVIEW_NOT_IN_LIST);
    const held = entry.held.get(linearId);
    if (held) return held.response;
    let reading = entry.reading.get(linearId);
    if (!reading) {
      reading = this.readHeld(entry, entry.rows.get(linearId)!).finally(() => entry.reading.delete(linearId));
      entry.reading.set(linearId, reading);
    }
    return (await reading).response;
  }

  /** The list a start is made from, while it is still the folder's current one. Throws `out-of-date` otherwise. */
  current(previewId: string): PlanQueueLinearPreview {
    return this.live(previewId).response;
  }

  /** The text kept for a ticket, for the run that starts from this preview. Null when none was loaded. */
  shownText(previewId: string, linearId: string): HeldTicketText | null {
    return this.live(previewId).held.get(linearId) ?? null;
  }

  /** Forgets a preview, for when a run starts from it. */
  drop(previewId: string): void {
    for (const entry of this.byFolder.values()) if (entry.id === previewId) this.remove(entry);
  }

  _resetForTesting(): void {
    for (const entry of [...this.byFolder.values()]) this.remove(entry);
    this.loading.clear();
  }

  private async runLoad(folder: string, key: string): Promise<PlanQueueLinearPreview> {
    const counter = new LinearCallCounter(this.deps.callLimit ?? LINEAR_DISCOVERY_CALL_LIMIT);
    let discovery: FolderDiscovery;
    try {
      discovery = await this.deps.discover(folder, counter);
    } catch (error) {
      logger.info('Linear preview load failed', { calls: counter.calls });
      throw error;
    }
    logger.info('Linear preview loaded', { calls: counter.calls });

    const loadedAt = this.deps.now();
    const lifetime = this.deps.lifetimeMs ?? LINEAR_PREVIEW_LIFETIME_MS;
    const response: PlanQueueLinearPreview = {
      previewId: randomUUID(),
      loadedAt,
      expiresAt: loadedAt + lifetime,
      folder,
      projects: this.projectsOf(discovery),
      rows: discovery.rows.map((row) => ({ ...row, labels: [...row.labels], waitingFor: [...row.waitingFor], notes: [...row.notes] })),
      labelNote: discovery.labelNote,
    };
    const previous = this.byFolder.get(key);
    if (previous) this.remove(previous);
    const entry: PreviewEntry = {
      id: response.previewId,
      folderKey: key,
      response,
      counter,
      rows: new Map(response.rows.map((row) => [row.id, row])),
      held: new Map(),
      reading: new Map(),
      timer: setTimeout(() => this.drop(response.previewId), lifetime),
    };
    entry.timer.unref?.();
    this.byFolder.set(key, entry);
    return response;
  }

  private projectsOf(discovery: FolderDiscovery): PlanQueueLinearPreviewProject[] {
    const saved = this.deps.readTeams();
    return discovery.projects.map((project) => {
      const team = discovery.teams.find((candidate) => candidate.teamId === project.teamId);
      const allowed: PlanQueueLinearPreviewProvider[] = (saved.find((rules) => rules.teamId === project.teamId)?.providers ?? [])
        .map((id) => ({ id, label: this.deps.providerLabel(id) }));
      return {
        projectId: project.id,
        projectName: project.name,
        teamId: project.teamId,
        teamKey: team?.teamKey ?? project.teamKey,
        ownership: team?.ownership ?? null,
        ready: team?.ready ?? false,
        reasons: [...(team?.reasons ?? [])],
        allowedProviders: allowed,
      };
    });
  }

  private async readHeld(entry: PreviewEntry, row: PlanQueueLinearPreviewRow): Promise<HeldTicketText> {
    let read: TicketTextRead;
    try {
      read = await this.deps.readText(row.identifier, entry.counter);
    } catch (error) {
      logger.info('Linear preview text failed', { calls: entry.counter.calls });
      if (isLinearCallLimitError(error)) throw new LinearPreviewError('call-limit', LINEAR_PREVIEW_TOO_MANY);
      throw error;
    }
    // A newer load, a drop or the 30 minutes may have come while Linear was answering: the text is then no one's.
    this.requireCurrent(entry);
    const held = this.holdText(entry, row, read);
    entry.held.set(row.id, held);
    return held;
  }

  private holdText(entry: PreviewEntry, row: PlanQueueLinearPreviewRow, read: TicketTextRead): HeldTicketText {
    const { ticket } = read;
    const parent = ticket.parentId === null ? undefined : entry.response.rows.find((candidate) => candidate.id === ticket.parentId);
    const text = approvedTextOf(read, {
      parentIdentifier: parent?.identifier,
      linkedProjectIds: new Set(entry.response.projects.map((project) => project.projectId)),
      tickets: entry.response.rows.map((candidate) => ({ identifier: candidate.identifier, title: candidate.title, projectId: candidate.projectId })),
    });
    const overLimit = isBriefOverLimit(buildTicketBrief({ identifier: ticket.identifier, title: ticket.title, text }));
    const response: PlanQueueLinearPreviewText = {
      linearId: row.id,
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      comments: text.comments.map(({ id, authorName, body, createdAt, updatedAt, fromBot }) => ({ id, authorName, body, createdAt, updatedAt, fromBot })),
      hash: read.hash,
      overLimit,
    };
    return { linearId: row.id, identifier: ticket.identifier, address: ticket.url, title: ticket.title, text, hash: read.hash, overLimit, response };
  }

  /** The preview a request names, when it is still the folder's current one and has not run out. */
  private live(previewId: string): PreviewEntry {
    for (const entry of this.byFolder.values()) {
      if (entry.id !== previewId) continue;
      this.requireCurrent(entry);
      return entry;
    }
    throw new LinearPreviewError('out-of-date', LINEAR_PREVIEW_OUT_OF_DATE);
  }

  private requireCurrent(entry: PreviewEntry): void {
    if (this.byFolder.get(entry.folderKey) !== entry) throw new LinearPreviewError('out-of-date', LINEAR_PREVIEW_OUT_OF_DATE);
    if (this.deps.now() >= entry.response.expiresAt) {
      this.remove(entry);
      throw new LinearPreviewError('out-of-date', LINEAR_PREVIEW_OUT_OF_DATE);
    }
  }

  private remove(entry: PreviewEntry): void {
    clearTimeout(entry.timer);
    if (this.byFolder.get(entry.folderKey) === entry) this.byFolder.delete(entry.folderKey);
  }
}
