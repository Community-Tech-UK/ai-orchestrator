import { describe, expect, it, vi } from 'vitest';

// The real wiring reads the saved settings; a test has none, so the app has no Linear connection set up.
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../orchestration/loop-store', () => ({ getLoopStoreService: () => ({ getDb: () => null }) }));

import { LINEAR_REF_PREFIX, createLinearWorkSource, linearIdOfRef, reduceTitle, type LinearWorkSourceDependencies } from './plan-queue-linear-source';
import { LANDING_COMMIT_PREFIXES } from './plan-queue-work-source';
import { allWorkSources, workSourceFor, workSourceForRun } from './plan-queue-work-sources';
import { markdownWorkSource } from './plan-queue-markdown-source';
import type { DiscoveryResult, DiscoveryRow } from './linear/linear-discovery';
import { LinearDiscoveryFailure } from './linear/linear-ticket-reader';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const row = (identifier: string, canTick: boolean): DiscoveryRow => ({
  id: `uuid-${identifier}`, identifier, title: `Title ${identifier}`, priority: 3, assigneeName: null, labels: [], teamId: 'team', projectId: 'project',
  ticked: canTick, canTick, waitingFor: [], reason: canTick ? null : 'Already in a run', notes: [],
});

function make(overrides: Partial<LinearWorkSourceDependencies> = {}) {
  const discover = vi.fn(async (): Promise<DiscoveryResult> => ({ rows: [row('ORC-3', true), row('ORC-4', false), row('ORC-5', true)], labelNote: null }));
  const deps: LinearWorkSourceDependencies = {
    discover,
    connectionReason: () => null,
    namesFor: (id) => (id === 'uuid-ORC-3' ? { identifier: 'ORC-3', approvedTitle: 'Fix the login page, now!' } : undefined),
    ...overrides,
  };
  return { source: createLinearWorkSource(deps), discover };
}

const item = (sourceRef: string) => ({ sourceRef, sourceKind: 'linear' as const });
const run = { id: 'run-1', kind: 'tickets', workspaceCwd: '/work/project' } as unknown as PlanQueueRun;

describe('the Linear work source', () => {
  it('is the linear kind', () => {
    expect(make().source.kind).toBe('linear');
  });

  describe('discovery', () => {
    it('returns one candidate per row that can be ticked, in the order discovery gave, as linear:<issue id>', async () => {
      const { source, discover } = make();
      const found = await source.discover('/work/project', { kind: 'tickets' });
      expect(found).toEqual([
        { ref: 'linear:uuid-ORC-3', readiness: 'candidate', reason: null },
        { ref: 'linear:uuid-ORC-5', readiness: 'candidate', reason: null },
      ]);
      expect(discover).toHaveBeenCalledWith('/work/project');
    });

    it('gives a failure and no candidates when discovery fails', async () => {
      const { source } = make({ discover: async () => { throw new LinearDiscoveryFailure('rate-limited', 'Linear is limiting requests.'); } });
      await expect(source.discover('/work/project', { kind: 'tickets' })).rejects.toMatchObject({ code: 'rate-limited' });
    });

    it('keeps the reference as the triage agent reported it: it is not a path', () => {
      expect(make().source.resolveRef(run, 'linear:uuid-ORC-3')).toBe('linear:uuid-ORC-3');
    });
  });

  describe('holding a run', () => {
    it('returns the connection\'s sentence', () => {
      const sentence = 'Linear work is paused: no Linear connection has been chosen yet. Choose one on the Plan Queue page.';
      expect(make({ connectionReason: () => sentence }).source.reasonToHold(run)).toBe(sentence);
    });

    it('returns null when the connection is ready', () => {
      expect(make().source.reasonToHold(run)).toBeNull();
    });
  });

  describe('names, all from the ticket table', () => {
    const { source } = make();
    const known = item('linear:uuid-ORC-3');

    it('the display name and full name are the identifier and the approved title', () => {
      expect(source.displayName(known)).toBe('ORC-3 Fix the login page, now!');
      expect(source.fullName(known)).toBe('ORC-3 Fix the login page, now!');
    });

    it('the branch part reduces the title to letters, digits and hyphens', () => {
      expect(source.branchSlug(known)).toBe('ORC-3-Fix-the-login-page-now');
    });

    it('the branch part cuts the title to 40 characters', () => {
      const long = make({ namesFor: () => ({ identifier: 'ORC-3', approvedTitle: 'a'.repeat(100) }) }).source;
      expect(long.branchSlug(known)).toBe(`ORC-3-${'a'.repeat(40)}`);
    });

    it('the commit subject starts "Ticket: " and cuts the reduced title to 60 characters', () => {
      expect(source.commitSubject(known, { kind: 'tickets' })).toBe('Ticket: ORC-3 Fix-the-login-page-now');
      const long = make({ namesFor: () => ({ identifier: 'ORC-3', approvedTitle: 'word '.repeat(50) }) }).source;
      const subject = long.commitSubject(known, { kind: 'tickets' });
      expect(subject.startsWith('Ticket: ORC-3 ')).toBe(true);
      expect(subject.slice('Ticket: ORC-3 '.length).length).toBeLessThanOrEqual(60);
      expect(subject).toMatch(/^Ticket: ORC-3 [A-Za-z0-9-]+$/);
    });

    it('the commit subject starts with a prefix the interrupted-landing recogniser accepts', () => {
      const prefix = source.commitSubject(known, { kind: 'tickets' }).split(': ')[0];
      expect(LANDING_COMMIT_PREFIXES).toContain(prefix);
    });

    it('a title with characters that are unsafe in a branch or a commit line comes out with none of them', () => {
      const nasty = make({ namesFor: () => ({ identifier: 'ORC-3', approvedTitle: 'x"; rm -rf ~ $(whoami) \n..\\/' }) }).source;
      expect(nasty.branchSlug(known)).toMatch(/^[A-Za-z0-9-]+$/);
      expect(nasty.commitSubject(known, { kind: 'tickets' })).toMatch(/^Ticket: [A-Za-z0-9-]+ [A-Za-z0-9-]+$/);
    });

    it('the checkpoint trailer names the ticket', () => {
      expect(source.checkpointTrailer(known)).toBe('Ticket: ORC-3');
    });

    it('a ticket with no row yet is named by its reduced reference, not by an error', () => {
      expect(source.displayName(item('linear:abc-123'))).toBe('abc-123');
      expect(source.commitSubject(item('linear:abc-123'), { kind: 'tickets' })).toBe('Ticket: abc-123');
    });

    it('cuts a long title in a session name', () => {
      const long = make({ namesFor: () => ({ identifier: 'ORC-3', approvedTitle: 'a'.repeat(500) }) }).source;
      expect(long.displayName(known).length).toBe('ORC-3 '.length + 100);
    });
  });

  describe('closing: a ticket has no documents', () => {
    const { source } = make();
    const ticketItem = { ...item('linear:uuid-ORC-3'), id: 'item-1' } as unknown as PlanQueueItem;
    const reviewed = {} as never;

    it('prepareClose returns the commit form with no documents, and finishClose returns nothing', async () => {
      await expect(source.prepareClose(ticketItem, '/work/project', '/work/wt', reviewed)).resolves.toEqual({ mode: 'commit', documents: [] });
      await expect(source.finishClose(ticketItem, '/work/project', 'main', reviewed)).resolves.toEqual([]);
    });

    it('nothing is checked against a document', async () => {
      await expect(source.assertUnchangedSince(ticketItem, reviewed)).resolves.toBeUndefined();
    });

    it('writes no parked note and has none to remove', async () => {
      await expect(source.appendParkNote(ticketItem, run, 'verification-failed' as never, {} as never)).resolves.toBeNull();
      await expect(source.removeParkNote(ticketItem, 'branch')).resolves.toBeUndefined();
    });
  });

  describe('everything about documents in the root checkout answers "none"', () => {
    const { source } = make();
    const candidate = { ref: 'linear:uuid-ORC-3', readiness: 'candidate' as const };

    it('has no step jobs, no plan to wait for, no left-out note, no remembered decision', () => {
      expect(source.awaitsPlan(candidate)).toBe(false);
      expect(source.stepJobs(candidate, run)).toBeNull();
      expect(source.leftOutNote(candidate, run, {} as never, null)).toBeNull();
      expect(source.rememberedOutcome(candidate, run, undefined)).toEqual({ kind: 'none', detail: '' });
    });

    it('has no waiting items to reconcile and no missing document', async () => {
      await expect(source.reconcileWaiting({} as never, run)).resolves.toBeUndefined();
      await expect(source.missingNote(item('linear:uuid-ORC-3'), run)).resolves.toBeNull();
    });

    it('has no merge to settle, nothing in the root checkout to merge, and nothing interrupted', async () => {
      await expect(source.resolveSyncConflict('/work/wt', ['a.md'])).resolves.toBe(false);
      await expect(source.rootEditWouldMerge('/work/project', 'a', 'b', 'a.md')).resolves.toBe(false);
      await expect(source.recoverLandingMerge('/work/project', 'item-1')).resolves.toEqual({ ok: true, mergedPaths: [] });
      await expect(source.recoverInterruptedMerges({} as never)).resolves.toBeUndefined();
    });

    it('its overlap resolver allows a landing and has nothing to put back', async () => {
      const prepared = await source.overlapResolver('item-1').prepare({ repoRoot: '/work/project', baseTip: 'a', integrationTip: 'b', overlaps: [] });
      expect(prepared.ok).toBe(true);
      if (prepared.ok) {
        await expect(prepared.finish()).resolves.toEqual([]);
        await expect(prepared.undo()).resolves.toBeUndefined();
      }
    });
  });
});

describe('reducing a title', () => {
  it('keeps letters, digits and single hyphens, with none at either end', () => {
    expect(reduceTitle('  --Hello,   World!!  ', 40)).toBe('Hello-World');
    expect(reduceTitle('a-b', 40)).toBe('a-b');
  });

  it('cuts at the limit and leaves no hyphen at the cut', () => {
    expect(reduceTitle('abc def ghi', 4)).toBe('abc');
    expect(reduceTitle('abcdef', 3)).toBe('abc');
  });

  it('gives an empty string for a title with nothing safe in it', () => {
    expect(reduceTitle('日本語 !!!', 40)).toBe('');
  });
});

describe('references', () => {
  it('reads the Linear id out of a reference', () => {
    expect(LINEAR_REF_PREFIX).toBe('linear:');
    expect(linearIdOfRef('linear:abc')).toBe('abc');
    expect(linearIdOfRef('abc')).toBe('abc');
  });
});

describe('the source is registered', () => {
  it('an item of the linear kind and a tickets run use it', () => {
    expect(workSourceFor('linear').kind).toBe('linear');
    expect(workSourceForRun({ kind: 'tickets' }).kind).toBe('linear');
  });

  it('markdown behaviour is unchanged: no kind, markdown, plans and livetests all use the markdown source', () => {
    expect(workSourceFor(undefined)).toBe(markdownWorkSource);
    expect(workSourceFor('markdown')).toBe(markdownWorkSource);
    expect(workSourceForRun({ kind: 'plans' })).toBe(markdownWorkSource);
    expect(workSourceForRun({ kind: 'livetests' })).toBe(markdownWorkSource);
  });

  it('is in the list of all sources, which boot recovery walks', () => {
    expect(allWorkSources().map((source) => source.kind)).toEqual(['markdown', 'linear']);
  });
});

describe('the real wiring', () => {
  it('asks the app\'s own connection for its sentence and the ticket table for names, without throwing when neither is set up', () => {
    const source = workSourceForRun({ kind: 'tickets' });
    expect(source.reasonToHold(run)).toBe('Linear work is paused: no Linear connection has been chosen yet. Choose one on the Plan Queue page.');
    // No database is open in a test, so there is no row to name the ticket from: the reduced reference is used.
    expect(source.displayName(item('linear:abc-123'))).toBe('abc-123');
  });
});
