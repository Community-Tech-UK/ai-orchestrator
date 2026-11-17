/**
 * The Linear work source: a `tickets` run's items are Linear tickets, and an item's source reference is
 * `linear:<Linear issue id>`.
 *
 * It answers the whole `QueueWorkSource` port. What a ticket is called comes from the ticket table (the identifier and
 * the title James approved); nothing is read from Linear here except by `discover`, which builds the preview list in
 * code from fixed fields (`linear/linear-discovery.ts`). A ticket has no documents, so there is nothing to close, no
 * parked note to write (Linear comments are the write-back step's), and every document question answers "none".
 *
 * Importing the Linear folder is allowed for this file and listed on purpose in `linear-not-agent-reachable.spec.ts`:
 * the work source runs inside the app for the queue, and nothing that an agent can call reaches it by that route.
 */
import type { PlanQueueSourceKind } from '@contracts/schemas/plan-queue';
import { getLinearConnectionService } from './linear/linear-connection-singleton';
import type { DiscoveryResult } from './linear/linear-discovery';
import {
  LINEAR_DISCOVERY_CALL_LIMIT,
  readDiscoveryForFolder,
  type LinearTicketReaderDependencies,
} from './linear/linear-ticket-reader';
import { realLinearTicketReaderDependencies } from './linear/linear-ticket-reader-singleton';
import { LinearCallCounter } from './linear/linear-tickets';
import { getPlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store-singleton';
import type { LinearTicketNames } from './plan-queue-linear-ticket-store';
import type { QueueWorkSource, WorkCandidate, WorkItemRef } from './plan-queue-work-source';

export const LINEAR_REF_PREFIX = 'linear:';

/** The most characters of a title in a session name. */
const DISPLAY_TITLE_CHARS = 100;
/** A title reduced to letters, digits and hyphens is cut to this many characters for a branch and for a commit subject. */
const BRANCH_TITLE_CHARS = 40;
const COMMIT_TITLE_CHARS = 60;

export interface LinearWorkSourceDependencies {
  /** The preview rows for a folder. Throws `LinearDiscoveryFailure` and returns nothing when it cannot. */
  discover(folder: string): Promise<DiscoveryResult>;
  /** Why Linear work may not start now (the connection's own sentence), or null. */
  connectionReason(): string | null;
  /** What a ticket is called, by its Linear id. */
  namesFor(linearId: string): LinearTicketNames | undefined;
}

/** Letters, digits and hyphens only, cut to `max` characters with no hyphen at either end. */
export function reduceTitle(title: string, max: number): string {
  return title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+/, '').slice(0, max).replace(/-+$/, '');
}

export function linearIdOfRef(sourceRef: string): string {
  return sourceRef.startsWith(LINEAR_REF_PREFIX) ? sourceRef.slice(LINEAR_REF_PREFIX.length) : sourceRef;
}

export function createLinearWorkSource(deps: LinearWorkSourceDependencies): QueueWorkSource {
  /** The identifier and approved title for an item; before its ticket row exists, only the reduced reference. */
  const names = (item: WorkItemRef): { identifier: string; title: string } => {
    const id = linearIdOfRef(item.sourceRef);
    const found = deps.namesFor(id);
    return found ? { identifier: found.identifier, title: found.approvedTitle } : { identifier: reduceTitle(id, BRANCH_TITLE_CHARS), title: '' };
  };
  const displayName = (item: WorkItemRef): string => {
    const { identifier, title } = names(item);
    const shown = title.replace(/\s+/g, ' ').trim().slice(0, DISPLAY_TITLE_CHARS);
    return shown ? `${identifier} ${shown}` : identifier;
  };

  return {
    kind: 'linear' satisfies PlanQueueSourceKind,

    async discover(repoRoot) {
      const { rows } = await deps.discover(repoRoot);
      return rows.filter((row) => row.canTick).map((row): WorkCandidate => ({ ref: `${LINEAR_REF_PREFIX}${row.id}`, readiness: 'candidate', reason: null }));
    },
    // A reference is not a path: whatever the triage agent reported is the reference.
    resolveRef: (_run, reported) => reported,
    awaitsPlan: () => false,
    stepJobs: () => null,
    leftOutNote: () => null,
    rememberedOutcome: () => ({ kind: 'none', detail: '' }),
    reconcileWaiting: async () => undefined,
    missingNote: async () => null,
    // The connection's own sentence: fixed words, so a run's reason can carry it. This is the caller pq-e1 built it for.
    reasonToHold: () => deps.connectionReason(),

    appendParkNote: async () => null,
    removeParkNote: async () => undefined,

    // A ticket's text is checked against Linear before each session (a later step); nothing here is a document.
    assertUnchangedSince: async () => undefined,
    prepareClose: async () => ({ mode: 'commit', documents: [] }),
    finishClose: async () => [],

    overlapResolver: () => ({ prepare: async () => ({ ok: true, finish: async () => [], undo: async () => undefined }) }),
    resolveSyncConflict: async () => false,
    rootEditWouldMerge: async () => false,
    recoverLandingMerge: async () => ({ ok: true, mergedPaths: [] }),
    recoverInterruptedMerges: async () => undefined,

    displayName,
    branchSlug: (item) => {
      const { identifier, title } = names(item);
      const reduced = reduceTitle(title, BRANCH_TITLE_CHARS);
      return reduced ? `${identifier}-${reduced}` : identifier;
    },
    fullName: displayName,
    checkpointTrailer: (item) => `Ticket: ${names(item).identifier}`,
    commitSubject: (item) => {
      const { identifier, title } = names(item);
      const reduced = reduceTitle(title, COMMIT_TITLE_CHARS);
      return `Ticket: ${identifier}${reduced ? ` ${reduced}` : ''}`;
    },
  };
}

/** The source wired to the real connection, settings and ticket table. */
export const linearWorkSource: QueueWorkSource = createLinearWorkSource({
  discover: (folder) => {
    const deps: LinearTicketReaderDependencies = realLinearTicketReaderDependencies();
    return readDiscoveryForFolder(folder, new LinearCallCounter(LINEAR_DISCOVERY_CALL_LIMIT), deps);
  },
  connectionReason: () => getLinearConnectionService().reasonToHold(),
  namesFor: (linearId) => getPlanQueueLinearTicketStore()?.findNames(linearId),
});
