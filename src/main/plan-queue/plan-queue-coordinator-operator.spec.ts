import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SET_ASIDE_FOLDER_METADATA } from './plan-queue-set-aside';
import {
  repo,
  store,
  fake,
  coordinator,
  personTurns,
  git,
  writeDoc,
  planDoc,
  implement,
  itemIdOf,
  pass,
  waitForRun,
  never,
  setQuestionsToParent,
} from './plan-queue-coordinator.test-helpers';

// The stand-ins every coordinator spec installs, and the shared fixture: see the two modules imported below.
vi.mock('./plan-queue-gate-receipts', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withScriptedGates(await original()));
vi.mock('./plan-queue-landing', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withLandingHooks(await original()));
vi.mock('../workspace/git/worktree-integration', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withPromotionHook(await original()));

describe('PlanQueueCoordinator — operator actions', { timeout: 30_000 }, () => {
  async function parkedAtRoundLimit(): Promise<{ runId: string; itemId: string; branch: string; parentId: string }> {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = (instance) => {
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'FAIL', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
      });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);
    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item.state).toBe('parked');
    return { runId: run.id, itemId: item.id, branch: item.branchName!, parentId: parent.id };
  }

  it('the Set aside agent clears only an empty job and cannot skip or adopt', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    const agent = fake.addParent();
    agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
    const events: unknown[] = [];
    coordinator.on('state-changed', (event) => events.push(event));

    expect(await coordinator.setAsideAgents.clear(agent.id)).toMatchObject({ cleared: 0, left: 1 });
    expect(git(['rev-parse', '--verify', branch])).toBeTruthy();
    await expect(coordinator.control({ action: 'skip-item', itemId }, agent.id)).rejects.toThrow('may only retry');
    await expect(coordinator.control({ action: 'adopt', runId }, agent.id)).rejects.toThrow('may only retry');
    await expect(coordinator.startRun({ parentInstanceId: agent.id, kind: 'plans' })).rejects.toThrow('Set aside session');

    git(['merge', '-q', '--no-edit', branch]);
    expect(await coordinator.setAsideAgents.clear(agent.id)).toMatchObject({ cleared: 0, left: 1 });
    const fresh = fake.addParent();
    fresh.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
    events.length = 0;
    expect(await coordinator.setAsideAgents.clear(fresh.id)).toMatchObject({ cleared: 1, left: 0 });
    expect(events).toEqual([{ runId }]);
    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ branchName: null });
    expect(coordinator.getRunDto(runId)!.items[0].discardedBy).toContain('the Set aside agent');
  });

  it('the Set aside agent can discard a job holding work, and bring it back', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    const agent = fake.addParent();
    agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };

    await coordinator.control({ action: 'discard-item', itemId }, agent.id);

    expect(git(['branch', '--list', branch])).toBe('');
    expect(coordinator.getRunDto(runId)!.items[0].discardedBy).toContain('the Set aside agent');

    await coordinator.control({ action: 'restore-discarded', itemId }, agent.id);

    expect(git(['branch', '--list', branch])).not.toBe('');
    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ state: 'parked', discardedAt: null });
  });

  it('lets another session discard a job while its owner is alive, and records who did', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    const other = fake.addParent();

    await coordinator.control({ action: 'discard-item', itemId }, other.id);

    expect(git(['branch', '--list', branch])).toBe('');
    expect(coordinator.getRunDto(runId)!.items[0].discardedBy).toBe(`session ${other.id}`);
  });

  it('refuses a Set aside agent\'s invalid retry before anything changes', async () => {
    const { runId, itemId } = await parkedAtRoundLimit();
    const agent = fake.addParent();
    agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
    const before = coordinator.getRunDto(runId)!.items[0];

    await expect(coordinator.control({ action: 'retry-landing', itemId }, agent.id)).rejects.toThrow('Only a land-blocked parked item');
    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ state: 'parked', parkReason: before.parkReason, branchName: before.branchName });
  });

  it('lets the Set aside agent merge a job without checks, and records that it did', async () => {
    const { runId, itemId } = await parkedAtRoundLimit();
    const agent = fake.addParent();
    agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };

    await coordinator.control({ action: 'land-anyway', itemId }, agent.id);
    await coordinator._whenSettledForTesting();

    const landed = coordinator.getRunDto(runId)!.items[0];
    expect(landed.state).toBe('landed');
    expect(landed.detail).toContain(`Landed without a verifier PASS by the Set aside agent (session ${agent.id})`);
    expect(git(['log', '-1', '--format=%s', 'main'])).toBe('Plan: 2026-01-01-alpha_plan');
  });

  describe('a document with another merged attempt', () => {
    async function withMergedAttempt(startedAfterParked: number) {
      const parked = await parkedAtRoundLimit();
      const item = coordinator.getItem(parked.itemId);
      store.upsertRun({ ...coordinator.getRun(parked.runId), id: 'run-that-merged' });
      store.upsertItem({ ...item, id: 'merged-attempt', runId: 'run-that-merged', state: 'landed', createdAt: item.createdAt + startedAfterParked });
      return parked;
    }

    it('refuses the Set aside agent\'s Land anyway over a newer merged attempt, which stays James\'s choice', async () => {
      const { itemId } = await withMergedAttempt(1);
      const agent = fake.addParent();
      agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
      await expect(coordinator.control({ action: 'land-anyway', itemId }, agent.id)).rejects.toThrow('A newer attempt at this document has already merged');
      expect(coordinator.getItem(itemId).state).toBe('parked');
    });

    it.each(['resume-item', 'retry-landing'] as const)('refuses %s once a newer attempt has merged', async (action) => {
      const { itemId } = await withMergedAttempt(1);
      await expect(coordinator.control({ action, itemId })).rejects.toThrow('already merged');
      expect(coordinator.getItem(itemId).state).toBe('parked');
    });

    it('still refuses after a routine save moves the job\'s last-updated time past the merge', async () => {
      const { itemId } = await withMergedAttempt(1);
      const item = coordinator.getItem(itemId);
      store.upsertItem({ ...item, updatedAt: item.updatedAt + 1_000_000 });
      await expect(coordinator.control({ action: 'resume-item', itemId })).rejects.toThrow('already merged');
    });

    it('lets a newer attempt continue after an older one merged', async () => {
      const { itemId } = await withMergedAttempt(-1);
      await coordinator.control({ action: 'resume-item', itemId });
      expect(coordinator.getItem(itemId).state).not.toBe('parked');
    });
  });

  it('the Set aside agent resumes a job through the normal path', async () => {
    const { runId, itemId } = await parkedAtRoundLimit();
    const agent = fake.addParent();
    agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
    fake.scripts.verifier = pass;
    await coordinator.control({ action: 'resume-item', itemId }, agent.id);
    await waitForRun(runId);
    expect(coordinator.getRunDto(runId)!.items[0].state).toBe('landed');
  });

  it('Resume re-opens the run, reattaches the parked branch and lands it', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    fake.scripts.verifier = pass;

    await coordinator.control({ action: 'resume-item', itemId });
    await waitForRun(runId);

    const item = coordinator.getRunDto(runId)!.items[0];
    expect(item).toMatchObject({ state: 'landed', parkReason: null });
    const resumedWorker = fake.created.filter((i) => i.role === 'worker').at(-1)!;
    expect(resumedWorker.config.initialPrompt).toContain('James resumed this parked item');
    expect(resumedWorker.config.initialPrompt).toContain(branch);
    expect(git(['show', 'main:2026-01-01-alpha_plan.feature.txt'])).toBe('built 2026-01-01-alpha_plan');
  });

  it('Resume on a discarded job carries on from its kept work and lands it', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    fake.scripts.verifier = pass;
    await coordinator.control({ action: 'discard-item', itemId });
    expect(git(['branch', '--list', branch])).toBe('');

    await coordinator.control({ action: 'resume-item', itemId });
    await waitForRun(runId);

    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ state: 'landed', discardedAt: null });
    expect(fake.created.filter((i) => i.role === 'worker').at(-1)!.config.initialPrompt).toContain(branch);
  });

  it('Resume sends the worker the findings the item was parked with', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = (instance) => {
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'FAIL', gates_run: [], document_complete: false, need_james: [], not_checked: [],
        findings: [{ severity: 'high', confidence: 90, summary: 'The retry path never resets the attempt counter.' }],
      });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);
    const parked = coordinator.getRunDto(run.id)!.items[0];
    expect(parked.state).toBe('parked');
    fake.scripts.verifier = pass;

    await coordinator.control({ action: 'resume-item', itemId: parked.id });
    await waitForRun(run.id);

    const resumedWorker = fake.created.filter((i) => i.role === 'worker').at(-1)!;
    expect(resumedWorker.config.initialPrompt).toContain('James resumed this parked item');
    expect(resumedWorker.config.initialPrompt).toContain('The retry path never resets the attempt counter.');
  });

  it('Resume checks a held item out again when its folder was half-removed, then checks and lands it', async () => {
    appendFileSync(join(repo, '.gitignore'), '_scratch/\n');
    git(['commit', '-qam', 'ignore scratch']);
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    // As on 26 Oct: paused while waiting for its checker, its folder reduced to an ignored _scratch.
    const leftover = join(repo, '.worktrees', branch);
    mkdirSync(join(leftover, '_scratch'), { recursive: true });
    writeFileSync(join(leftover, '_scratch', 'notes.txt'), 'scratch\n');
    store.upsertItem({ ...store.getItem(itemId)!, state: 'awaiting-slot', worktreePath: leftover, round: 0, verdict: null, parkReason: null, detail: 'Paused', heldAt: Date.now() });
    store.upsertRun({ ...store.getRun(runId)!, status: 'paused', endedAt: null });
    fake.scripts.verifier = pass;

    await coordinator.control({ action: 'resume', runId });
    await waitForRun(runId);

    expect(store.getItem(itemId)).toMatchObject({ state: 'landed' });
    expect(git(['show', 'main:2026-01-01-alpha_plan.feature.txt'])).toBe('built 2026-01-01-alpha_plan');
    const [moved] = readdirSync(join(repo, '.worktrees/queue-quarantine'));
    expect(readFileSync(join(repo, '.worktrees/queue-quarantine', moved!, 'leftover/_scratch/notes.txt'), 'utf8')).toBe('scratch\n');
  });

  it.each([
    { change: 'code repair', resume: 'explicit resume' },
    { change: 'document only', resume: 'explicit resume' },
    { change: 'code repair', resume: 'legacy awaiting verification' },
    { change: 'document only', resume: 'legacy awaiting verification' },
  ] as const)('$resume rebuilds a blocked candidate for $change', async ({ change, resume }) => {
    const doc = planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    const hooks = join(repo, '.git', 'hooks');
    const counter = join(repo, '.git', 'landing-hook-runs');
    // The operator edits a.txt in the main folder while the first landing's hook runs: after the pre-commit overlap
    // check (which would make the landing wait before the hook), so only promotion sees it and the candidate exists.
    writeFileSync(join(hooks, 'pre-commit'),
      `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) > "${counter}"\n[ "$n" = 0 ] && echo 'operator work' > "${join(repo, 'a.txt')}"\nexit 0\n`);
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(['config', 'core.hooksPath', hooks]);
    fake.scripts.worker = (instance) => {
      writeFileSync(join(instance.workingDirectory!, 'a.txt'), 'first version\n');
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    // Promotion refuses the edit, so the landing waits; it has waited the full 24 hours by the next pump.
    await vi.waitFor(() => expect(store.getItem(run.items[0].id)?.landingWaitPaths).toEqual(['a.txt']), { timeout: 30_000 });
    store.upsertItem({ ...store.getItem(run.items[0].id)!, landingWaitSince: Date.now() - 25 * 60 * 60_000 });
    coordinator.requestPump();
    await waitForRun(run.id);
    const before = store.getItem(run.items[0].id)!;
    expect(before).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(before.landedCommit).not.toBeNull();
    expect(git(['show', `${before.landedCommit}:a.txt`])).toBe('first version');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('operator work\n');
    expect(readFileSync(counter, 'utf8').trim()).toBe('1');
    appendFileSync(doc, '\nNew acceptance evidence from the resumed round.\n');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    const repair = (worktreePath: string) => {
      if (change === 'code repair') {
        writeFileSync(join(worktreePath, 'a.txt'), 'repaired version\n');
        writeFileSync(join(worktreePath, 'repair.txt'), 'required new repair\n');
      }
    };
    fake.scripts.worker = (instance) => repair(instance.workingDirectory!);
    fake.scripts.verifier = (instance, message, instances) => {
      expect(store.getItem(before.id)!.landedCommit).toBeNull();
      return pass(instance, message, instances);
    };

    if (resume === 'explicit resume') {
      await coordinator.control({ action: 'resume-item', itemId: before.id }, parent.id);
      expect(store.getItem(before.id)).toMatchObject({ landedCommit: null, verdict: null, verifiedMainCommit: null });
    } else {
      // Persisted state from the old app: its worker already checkpointed the
      // repair, but left the original prepared candidate in the item row.
      let waiting = await coordinator.worktrees.reattach(before, repo);
      repair(waiting.worktreePath!);
      waiting = await coordinator.worktrees.checkpoint(waiting, 'legacy worker finished');
      store.upsertItem({ ...waiting, state: 'awaiting-slot', landedCommit: before.landedCommit });
      store.upsertRun({ ...store.getRun(run.id)!, status: 'running', endedAt: null });
      coordinator.requestPump();
    }
    await waitForRun(run.id);

    const after = store.getItem(before.id)!;
    expect(after).toMatchObject({ state: 'landed', branchName: null, worktreePath: null });
    expect(after.landedCommit).not.toBe(before.landedCommit);
    expect(git(['rev-parse', 'main'])).toBe(after.landedCommit);
    expect(git(['show', 'main:a.txt'])).toBe(change === 'code repair' ? 'repaired version' : 'first version');
    if (change === 'code repair') {
      expect(git(['show', 'main:repair.txt'])).toBe('required new repair');
      expect(after.checkpointCommit).not.toBe(before.checkpointCommit);
    } else {
      expect(after.checkpointCommit).toBe(before.checkpointCommit);
    }
    expect(git(['show', 'main:docs/plans/2026-01-01-alpha_plan_completed.md']))
      .toContain('New acceptance evidence from the resumed round.');
    expect(readFileSync(counter, 'utf8').trim()).toBe('2');
    expect(git(['log', '--format=%s', 'main']).split('\n')).toEqual(['Plan: 2026-01-01-alpha_plan', 'base']);
    expect(git(['branch', '--list', before.branchName!])).toBe('');
  });

  it('Land anyway squashes the parked branch without closing the document', async () => {
    const { runId, itemId } = await parkedAtRoundLimit();

    await coordinator.control({ action: 'land-anyway', itemId });
    await coordinator._whenSettledForTesting();

    const item = coordinator.getRunDto(runId)!.items[0];
    expect(item.state).toBe('landed');
    expect(item.detail).toContain('without a verifier PASS');
    expect(git(['log', '-1', '--format=%s', 'main'])).toBe('Plan: 2026-01-01-alpha_plan');
    expect(existsSync(join(repo, 'docs/plans/2026-01-01-alpha_plan.md'))).toBe(true);
    expect(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/queue/'])).toBe('');
  });

  describe('Land anyway from the session that started the run', () => {
    /** The park time comes from the queue's event record; a person's message is typed relative to it. */
    const parkedAt = (itemId: string): number => store.history.lastParkedAt(itemId)!;
    /** A person's message in the parent session that has started its turn. */
    function personMessage(parentId: string, typedAt: number, messageId = 'msg-1'): void {
      personTurns.setReportsTurnStarts(parentId, true);
      personTurns.noteInput(parentId, { messageId, personTypedAt: typedAt });
      personTurns.noteTurnStarted(parentId, 'harness-send');
    }
    async function expectStillParked(runId: string, itemId: string, branch: string): Promise<void> {
      await coordinator._whenSettledForTesting();
      expect(coordinator.getRunDto(runId)!.items[0].state).toBe('parked');
      expect(store.getItem(itemId)!.state).toBe('parked');
      expect(git(['branch', '--list', branch])).not.toBe('');
    }

    it('lands in the turn a person\'s message started after the item parked, names the actor and keeps a reference, not the text', async () => {
      const { runId, itemId, parentId } = await parkedAtRoundLimit();
      personMessage(parentId, parkedAt(itemId) + 60_000);

      await coordinator.control({ action: 'land-anyway', itemId }, parentId);
      await coordinator._whenSettledForTesting();

      const item = coordinator.getRunDto(runId)!.items[0];
      expect(item.state).toBe('landed');
      expect(item.detail).toMatch(/^Landed without a verifier PASS by the session that started the run, after James's message at \d\d:\d\d; the document was left open\./);
      expect(item.detail).not.toContain('by James');
      const note = store.history.listEvents(itemId).find((event) => event.reason === 'land-anyway-authorised')!;
      expect(JSON.parse(note.detailHead!)).toEqual({ actor: 'session', instanceId: parentId, messageId: 'msg-1', typedAt: parkedAt(itemId) + 60_000 });
      expect(existsSync(join(repo, 'docs/plans/2026-01-01-alpha_plan.md'))).toBe(true);
    });

    it('the Plan Queue page still lands, with no message needed, and says so', async () => {
      const { runId, itemId } = await parkedAtRoundLimit();

      await coordinator.control({ action: 'land-anyway', itemId });
      await coordinator._whenSettledForTesting();

      expect(coordinator.getRunDto(runId)!.items[0].detail).toMatch(/^Landed without a verifier PASS from the Plan Queue page; the document was left open\./);
      expect(JSON.parse(store.history.listEvents(itemId).find((event) => event.reason === 'land-anyway-authorised')!.detailHead!)).toEqual({ actor: 'page' });
    });

    it.each([
      ['the latest input after the message was an automation prompt, another agent\'s message, a queue notice or a steer',
        (parentId: string) => personTurns.noteInput(parentId, { messageId: 'notice', personTypedAt: null }), /wasn't a message James typed or spoke/],
      ['a turn started by itself after the message (Claude CLI background job, Codex goal turn)',
        (parentId: string) => personTurns.noteTurnStarted(parentId, 'provider'), /Another turn has started since/],
      ['the provider cannot report turn starts',
        (parentId: string) => personTurns.setReportsTurnStarts(parentId, false), /can't report when a turn starts/],
    ])('refuses when %s', async (_label, interfere, reason) => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      personMessage(parentId, parkedAt(itemId) + 60_000);
      interfere(parentId);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, parentId)).rejects.toThrow(reason);

      await expectStillParked(runId, itemId, branch);
      expect(store.history.listEvents(itemId).some((event) => event.reason === 'land-anyway-authorised')).toBe(false);
    });

    it('refuses a message from before the item parked', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      personMessage(parentId, parkedAt(itemId) - 60_000);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, parentId)).rejects.toThrow(/before this item parked/);

      await expectStillParked(runId, itemId, branch);
    });

    it('refuses a parent with no message at all, which is also how it stands after a restart', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      personTurns.setReportsTurnStarts(parentId, true);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, parentId)).rejects.toThrow(/no message from James in this session/);

      await expectStillParked(runId, itemId, branch);
    });

    it('refuses a queue session, even when a person\'s message is on record for it', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      personMessage(parentId, parkedAt(itemId) + 60_000);
      const worker = fake.addParent();
      worker.metadata = { planQueueRole: 'worker' };
      personMessage(worker.id, parkedAt(itemId) + 60_000);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, worker.id)).rejects.toThrow(/queue worker or checker can't land work/);

      await expectStillParked(runId, itemId, branch);
    });

    it('refuses the stranded-run rescuer, which has its own person message on record', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      const rescuer = fake.addParent();
      personMessage(rescuer.id, parkedAt(itemId) + 60_000);
      fake.live.delete(parentId);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, rescuer.id)).rejects.toThrow(/isn't a rescue action/);

      await expectStillParked(runId, itemId, branch);
    });

    it('refuses another session while the parent is alive', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      const other = fake.addParent();
      personMessage(other.id, parkedAt(itemId) + 60_000);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, other.id)).rejects.toThrow(/Only the session that started this Plan Queue run/);

      await expectStillParked(runId, itemId, branch);
      expect(parentId).not.toBe(other.id);
    });

    it('a message that was typed before the park but sent after it does not count, because the typed time is what is checked', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      // Sent after the park (the registry records it now) but typed before it, while the session was busy.
      personMessage(parentId, parkedAt(itemId) - 1);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, parentId)).rejects.toThrow(/before this item parked/);

      await expectStillParked(runId, itemId, branch);
    });
  });

  it('Discard deletes only the parked branch, and only on request', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    expect(git(['branch', '--list', branch])).not.toBe('');

    await coordinator.control({ action: 'discard-item', itemId });

    expect(git(['branch', '--list', branch])).toBe('');
    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ discardedBy: 'James', branchName: null });
    await expect(coordinator.control({ action: 'skip-item', itemId })).rejects.toThrow(/has not started/);
  });

  it('brings discarded work back, and refuses a job that was never discarded', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    const tip = git(['rev-parse', branch]);
    await expect(coordinator.control({ action: 'restore-discarded', itemId })).rejects.toThrow('Only a discarded job');

    await coordinator.control({ action: 'discard-item', itemId });
    expect(git(['branch', '--list', branch])).toBe('');
    await coordinator.control({ action: 'restore-discarded', itemId });

    expect(git(['rev-parse', branch])).toBe(tip);
    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ state: 'parked', branchName: branch, discardedAt: null, discardedBy: null });
    expect(git(['for-each-ref', 'refs/plan-queue/discarded/'])).toBe('');
  });

  it('lets another session cancel a run whose parent session is gone, and records who did it', async () => {
    writeDoc('docs/plans/2026-01-01-orphan_plan.md', '# Plan\n\n**Spec:** [spec](./2026-01-01-orphan_spec_planned.md)\n');
    const parent = fake.addParent();
    const rescuer = fake.addParent();
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    store.upsertItem({ ...store.getItem(run.items[0].id)!, state: 'needs-answer', question: {
      question: 'May this campaign expand its scope?',
      options: [{ id: 'proceed', label: 'Approve' }, { id: 'skip', label: 'Leave it' }],
      decision: { kind: 'human-authority', reason: 'New scope requires approval.' },
    } });
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('needs-answer');

    // While the parent lives, the run is still the parent's alone.
    await expect(coordinator.control({ action: 'cancel', runId: run.id }, rescuer.id)).rejects.toThrow(/Only the session that started/);

    fake.live.delete(parent.id);
    // A session the queue spawned can never rescue, and the rescue covers only adopt and cancel.
    fake.live.set('worker-other-run', { ...rescuer, id: 'worker-other-run', metadata: { planQueueRole: 'worker' } });
    await expect(coordinator.control({ action: 'cancel', runId: run.id }, 'worker-other-run')).rejects.toThrow(/Only the session that started/);
    await expect(coordinator.control({ action: 'pause', runId: run.id }, rescuer.id)).rejects.toThrow(/Use action "adopt" to take over/);
    await expect(coordinator.answer(run.items[0].id, 'proceed', rescuer.id)).rejects.toThrow(/Only the session that started/);
    expect(coordinator.getRunDto(run.id)!.status).toBe('running');

    await coordinator.control({ action: 'cancel', runId: run.id }, rescuer.id);

    const cancelled = coordinator.getRunDto(run.id)!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.items[0].state).toBe('skipped');
    expect(cancelled.items[0].detail).toBe(
      `Run cancelled by session ${rescuer.id}, because the session that started the run (${parent.id}) no longer exists.`,
    );
    // Its documents are free again: a new run claims them.
    const next = await coordinator.startRun({ parentInstanceId: rescuer.id, kind: 'plans' });
    expect(next.excluded).toEqual([]);
    expect(next.run.items).toHaveLength(1);
  });

  it('lets another session discard a stranded run\'s parked item, and nothing else', async () => {
    const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
    const rescuer = fake.addParent();
    fake.live.delete(parentId);

    await expect(coordinator.control({ action: 'resume-item', itemId }, rescuer.id)).rejects.toThrow(/Use action "adopt" to take over/);
    await expect(coordinator.control({ action: 'land-anyway', itemId }, rescuer.id)).rejects.toThrow(/Use action "adopt" to take over/);
    expect(git(['branch', '--list', branch])).not.toBe('');

    await coordinator.control({ action: 'discard-item', itemId }, rescuer.id);

    expect(git(['branch', '--list', branch])).toBe('');
    expect(coordinator.getRunDto(runId)!.items[0].discardedBy).toBe(`session ${rescuer.id}`);
  });

  it('surfaces a worker waiting for input as a question and resumes it on "continue"', async () => {
    setQuestionsToParent(true);
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    let asked = false;
    fake.scripts.worker = async (instance, message, f) => {
      if (!asked) {
        asked = true;
        f.say(instance, 'Should the retention period be 30 or 90 days?');
        f.setStatus(instance, 'waiting_for_input');
        return;
      }
      await implement(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await vi.waitFor(() => {
      if (!coordinator.getRunDto(run.id)!.items[0].question) throw new Error('no question yet');
    }, { timeout: 15_000, interval: 25 });
    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item.question?.question).toContain('retention period');
    expect(item.question?.options.map((o) => o.id)).toEqual(['continue', 'park']);
    expect(fake.inputs.some((m) => m.instanceId === parent.id && m.message.includes(`item_id "${item.id}"`))).toBe(true);

    await coordinator.answer(item.id, 'continue');
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', question: null });
  });
});
