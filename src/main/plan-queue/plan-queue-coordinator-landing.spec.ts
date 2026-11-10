import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueFolderChecklist } from '@contracts/schemas/plan-queue';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { landing, machineGates } from './plan-queue-coordinator.test-mocks';
import {
  repo,
  store,
  fake,
  coordinator,
  git,
  writeDoc,
  planDoc,
  implement,
  pass,
  waitForRun,
  never,
  restart,
  setSavedFolderChecklists,
  type Script,
  type FakeInstance,
} from './plan-queue-coordinator.test-helpers';

// The stand-ins every coordinator spec installs, and the shared fixture: see the two modules imported below.
vi.mock('./plan-queue-gate-receipts', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withScriptedGates(await original()));
vi.mock('./plan-queue-landing', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withLandingHooks(await original()));
vi.mock('../workspace/git/worktree-integration', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withPromotionHook(await original()));

describe('PlanQueueCoordinator — merge conflicts are never committed unresolved', { timeout: 40_000 }, () => {
  const CONFLICT = 'merge has conflicts';
  const whichItem = (instance: FakeInstance) => (instance.workingDirectory!.includes('alpha') ? 'alpha' : 'beta');

  /** Both items add shared.txt; alpha lands first, so beta's pre-verification merge conflicts. */
  function conflictingWorkers(onConflict: Script): void {
    fake.scripts.worker = async (instance, message, f) => {
      if (message.includes(CONFLICT)) {
        await onConflict(instance, message, f);
        return;
      }
      await implement(instance, message, f);
      writeFileSync(join(instance.workingDirectory!, 'shared.txt'), `${whichItem(instance)}\n`);
    };
  }

  const resolve: Script = (instance) => {
    writeFileSync(join(instance.workingDirectory!, 'shared.txt'), 'alpha+beta\n');
    execFileSync('git', ['add', 'shared.txt'], { cwd: instance.workingDirectory! });
  };

  async function startConflict(onConflict: Script): Promise<{ runId: string; beta: () => ReturnType<PlanQueueCoordinator['getRunDto']> }> {
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    conflictingWorkers(onConflict);
    const { run } = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', config: { workerSlots: 2, verificationSlots: 1, postMergeGate: [] },
    });
    await vi.waitFor(() => {
      if (!fake.inputs.some((m) => m.message.includes(CONFLICT))) throw new Error('no conflict yet');
    }, { timeout: 20_000, interval: 25 });
    return { runId: run.id, beta: () => coordinator.getRunDto(run.id) };
  }

  /** The item whose pre-verification merge conflicted (whichever verified second). */
  function conflicted(runId: string) {
    const input = fake.inputs.find((m) => m.message.includes(CONFLICT))!;
    const itemId = fake.created.find((i) => i.id === input.instanceId)!.config.metadata!['planQueueItemId'];
    return coordinator.getRunDto(runId)!.items.find((i) => i.id === itemId)!;
  }

  it('parks on cancel mid-resolution without committing the markers, and Resume re-sends the conflict', async () => {
    const { runId } = await startConflict(never);
    const worktree = conflicted(runId).worktreePath!;

    await coordinator.control({ action: 'cancel', runId });

    const beta = conflicted(runId);
    expect(beta).toMatchObject({ state: 'parked', parkReason: 'cancelled', worktreePath: worktree });
    expect(beta.detail).toContain('still in progress');
    expect(existsSync(worktree)).toBe(true);
    expect(git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktree)).not.toBe('');
    // The branch holds the worker's pre-merge checkpoint, never the markers.
    expect(git(['show', `${beta.branchName}:shared.txt`])).toMatch(/^(alpha|beta)$/);

    conflictingWorkers(resolve);
    await coordinator.control({ action: 'resume-item', itemId: beta.id });
    await waitForRun(runId);
    const resumed = fake.created.filter((i) => i.role === 'worker').at(-1)!;
    expect(resumed.config.initialPrompt).toContain(CONFLICT);
    expect(git(['show', 'main:shared.txt'])).toBe('alpha+beta');
  });

  it('parks as merge-conflict when the worker ends its turn with the merge unresolved', async () => {
    const { runId } = await startConflict(() => undefined);
    await waitForRun(runId);

    const beta = conflicted(runId);
    expect(beta).toMatchObject({ state: 'parked', parkReason: 'merge-conflict' });
    expect(beta.detail).toContain('shared.txt');
    expect(existsSync(beta.worktreePath!)).toBe(true);
    expect(git(['show', `${beta.branchName}:shared.txt`])).toMatch(/^(alpha|beta)$/);
    expect(git(['show', 'main:shared.txt'])).toMatch(/^(alpha|beta)$/);
  });

  it('after a restart mid-resolution, the new worker gets the conflict again and the resolution lands', async () => {
    const { runId } = await startConflict(never);
    const next = await restart();
    next.scripts.worker = async (instance, message, f) => {
      if (message.includes(CONFLICT)) await resolve(instance, message, f);
    };

    await waitForRun(runId);
    expect(next.created.find((i) => i.role === 'worker')!.config.initialPrompt).toContain(CONFLICT);
    expect(coordinator.getRunDto(runId)!.items.map((i) => i.state)).toEqual(['landed', 'landed']);
    expect(git(['show', 'main:shared.txt'])).toBe('alpha+beta');
  });

  it('clears a merge left behind by a crash before the item reached fixing, then redoes it', async () => {
    const { runId } = await startConflict(never);
    const beta = conflicted(runId);
    // The crash window: the merge failed but the row still says verifying.
    store.upsertItem({ ...store.getItem(beta.id)!, state: 'verifying', verifierInstanceId: null });

    const next = await restart();
    next.scripts.worker = async (instance, message, f) => {
      if (message.includes(CONFLICT)) await resolve(instance, message, f);
    };
    await waitForRun(runId);

    expect(coordinator.getRunDto(runId)!.items.map((i) => i.state)).toEqual(['landed', 'landed']);
    expect(git(['show', 'main:shared.txt'])).toBe('alpha+beta');
  });

  it('sends a stale PASS back to the worker when the landing-time merge conflicts, then lands the resolution', async () => {
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    conflictingWorkers(resolve);
    // Both items verify at the same time, so the second PASS is judged against
    // a main the first then moves: the conflict appears inside landing.
    let verifying = 0;
    let bothVerifying!: () => void;
    const gate = new Promise<void>((done) => { bothVerifying = done; });
    fake.scripts.verifier = async (instance, message, f) => {
      verifying += 1;
      if (verifying === 2) bothVerifying();
      if (verifying <= 2) await gate;
      await pass(instance, message, f);
    };

    const { run } = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', config: { workerSlots: 2, verificationSlots: 2, postMergeGate: [] },
    });
    await waitForRun(run.id);

    const second = conflicted(run.id);
    expect(fake.inputs.filter((m) => m.message.includes(CONFLICT))).toHaveLength(1);
    expect(second).toMatchObject({ state: 'landed', round: 2 });
    expect(git(['show', 'main:shared.txt'])).toBe('alpha+beta');
  });

  it('Land anyway on an item parked mid-merge re-sends the conflict instead of landing the markers', async () => {
    const { runId } = await startConflict(() => undefined);
    await waitForRun(runId);
    const parked = conflicted(runId);
    expect(parked.parkReason).toBe('merge-conflict');

    conflictingWorkers(resolve);
    await coordinator.control({ action: 'land-anyway', itemId: parked.id });
    await vi.waitFor(() => {
      if (coordinator.getRunDto(runId)!.items.some((i) => i.state !== 'landed')) throw new Error('not landed yet');
    }, { timeout: 20_000, interval: 25 });

    // The parked item's worker was retired, so a fresh worker gets the conflict as its first prompt.
    expect(fake.created.filter((i) => i.role === 'worker').at(-1)!.config.initialPrompt).toContain(CONFLICT);
    expect(git(['show', 'main:shared.txt'])).toBe('alpha+beta');
    expect(git(['log', '-p', 'main'])).not.toContain('<<<<<<<');
  });
});


describe('PlanQueueCoordinator — the landing commit runs the repository hooks', { timeout: 40_000 }, () => {
  /** A repo-local pre-commit hook; `counter` lets a script fail only its first N runs. */
  function installHook(script: string): void {
    const hooks = join(repo, 'test-hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(['config', 'core.hooksPath', hooks]);
    appendFileSync(join(repo, '.git', 'info', 'exclude'), 'test-hooks/\n');
  }

  it('sends a hook refusal back to the worker with the output, then lands once it passes', async () => {
    const counter = join(repo, '.git', 'hook-runs');
    // Fail the first landing commit only.
    installHook(`n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) > "${counter}"; if [ "$n" = 0 ]; then echo "related test failed: retry.spec.ts" >&2; exit 1; fi`);
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'landed', round: 2 });
    const worker = fake.created.find((i) => i.role === 'worker')!;
    const bounce = fake.inputs.find((m) => m.instanceId === worker.id);
    expect(bounce?.message).toContain('related test failed: retry.spec.ts');
    expect(git(['log', '--format=%s', 'main']).split('\n')).toEqual(['Plan: 2026-01-01-alpha_plan', 'base']);
  });

  it('sends a landing that keeps hitting a base conflict back to the worker three times, then parks it', async () => {
    landing.conflict = true;
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 10 } });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'merge-conflict' });
    expect(item.detail).toContain('already sent this back to the worker 3 times');
    expect(store.getItem(item.id)!.baseConflicts).toBe(0);
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(fake.inputs.filter((m) => m.instanceId === worker.id && m.message.includes('shared.txt'))).toHaveLength(3);
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });

  it('checks and builds again, with no worker, when main moved during landing but merges cleanly', async () => {
    landing.baseMovesOnce = () => {
      writeFileSync(join(repo, 'other.txt'), 'other\n');
      git(['add', 'other.txt']);
      git(['commit', '-q', '--no-verify', '-m', 'other work']);
    };
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'landed', round: 1 });
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(fake.inputs.filter((m) => m.instanceId === worker.id && m.message.includes('shared.txt'))).toHaveLength(0);
    expect(landing.mergeChecks).toBe(1);
    expect(git(['log', '--format=%s', 'main']).split('\n')).toEqual(['Plan: 2026-01-01-alpha_plan', 'other work', 'base']);
  });

  it('keeps the pass and starts no worker when the check after merging runs out of time', async () => {
    landing.mergeCheckTimeout = true;
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    const review = fake.scripts.verifier!;
    fake.scripts.verifier = (instance, message, f) => {
      // Main moves during review, so landing has to merge it and run the check after merging.
      writeFileSync(join(repo, 'other.txt'), 'other\n');
      git(['add', 'other.txt']);
      git(['commit', '-q', '--no-verify', '-m', 'other work']);
      return review(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked', verdict: { verdict: 'PASS' } });
    expect(item.detail).toContain('ran out of time');
    expect(store.getItem(item.id)!.baseConflicts).toBe(0);
    const workers = fake.created.filter((i) => i.role === 'worker');
    expect(workers).toHaveLength(1);
    expect(fake.inputs.filter((m) => m.instanceId === workers[0].id)).toHaveLength(0);

    // Trying again finds main already merged, but the check on that merge never finished.
    landing.mergeCheckTimeout = false;
    await coordinator.control({ action: 'retry-landing', itemId: item.id });
    await waitForRun(run.id);
    expect(landing.mergeChecks).toBe(2);
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
  });

  it('never sends a timed-out check to a worker, and stops the job as hung after two', async () => {
    machineGates.timeOutItem = true;
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { verifierGates: ['echo check'] } });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'check-hung', round: 0, verdict: null });
    const workers = fake.created.filter((i) => i.role === 'worker');
    expect(workers).toHaveLength(1);
    expect(fake.inputs.filter((m) => m.instanceId === workers[0].id)).toHaveLength(0);
    expect(fake.created.filter((i) => i.role === 'verifier')).toHaveLength(0);
  });

  it('parks at once, with no worker round, when the hook runs out of time', async () => {
    landing.hookTimeout = true;
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked', round: 1 });
    expect(item.detail).toContain('ran out of time');
    expect(store.getItem(item.id)!.landingRefusals).toBe(0);
    // Only the first worker turn: nothing was sent back to a worker for the timeout.
    const workers = fake.created.filter((i) => i.role === 'worker');
    expect(workers).toHaveLength(1);
    expect(fake.inputs.filter((m) => m.instanceId === workers[0].id)).toHaveLength(0);
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });

  it('parks, landing nothing, when the hook refuses the landing a second time', async () => {
    installHook('echo "generator drift" >&2; exit 1');
    const doc = planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item.detail).toContain('generator drift');
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
    expect(existsSync(doc)).toBe(true);
    expect(git(['rev-list', '--count', `main..${item.branchName}`])).not.toBe('0');
  });

  it('still parks on the second refusal when the app restarts between the two', async () => {
    const counter = join(repo, '.git', 'hook-runs');
    installHook(`n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) > "${counter}"; echo "generator drift" >&2; exit 1`);
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    let turns = 0;
    // The worker never finishes the fix turn the first refusal sends it.
    fake.scripts.worker = (instance, message, f) => (++turns === 1 ? implement(instance, message, f) : never(instance, message, f));

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    const itemId = coordinator.getRunDto(run.id)!.items[0].id;
    await vi.waitFor(() => {
      const item = store.getItem(itemId)!;
      if (item.state !== 'fixing' || item.landingRefusals !== 1) throw new Error(`item is ${item.state}/${item.landingRefusals}`);
    }, { timeout: 30_000 });

    await restart();
    await waitForRun(run.id);
    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item.detail).toContain('generator drift');
    expect(store.getItem(itemId)!.landingRefusals).toBe(0);
    // Exactly two landing attempts: a counter lost in the restart would allow a third.
    expect(readFileSync(counter, 'utf-8').trim()).toBe('2');
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });

  it('parks when the branch carries active planning documents a second time', async () => {
    // A tracked planning file is outside the move rule: an edit to it is committed, then refused at landing.
    writeFileSync(join(repo, 'scratch_plan.md'), '# scratch\n');
    git(['add', 'scratch_plan.md']); git(['commit', '--no-verify', '-qm', 'base']);
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    // The worker keeps editing the tracked scratch plan in its tree.
    fake.scripts.worker = (instance, message, f) => {
      writeFileSync(join(instance.workingDirectory!, 'scratch_plan.md'), '# scratch, edited\n');
      return implement(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item.detail).toContain('scratch_plan.md');
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(fake.inputs.some((m) => m.instanceId === worker.id && m.message.includes('scratch_plan.md'))).toBe(true);
    expect(git(['log', '--format=%s', 'main'])).toBe('base\nbase');
  });

  it('moves a worker-created planning file to the root checkout and lands the rest', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = (instance, message, f) => {
      writeFileSync(join(instance.workingDirectory!, 'scratch_history.md'), '# scratch journal\n');
      return implement(instance, message, f);
    };
    fake.scripts.verifier = pass;

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    expect(readFileSync(join(repo, 'scratch_history.md'), 'utf8')).toBe('# scratch journal\n');
    expect(git(['ls-tree', '-r', '--name-only', 'main']).split('\n').some((name) => name.includes('scratch_history'))).toBe(false);
  });

  it('promotes a recorded landing commit after a restart without closing the documents again', async () => {
    const doc = planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    landing.hangPromotion = true;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    const itemId = coordinator.getRunDto(run.id)!.items[0].id;
    await vi.waitFor(() => { if (!landing.hung) throw new Error('promotion not reached'); }, { timeout: 30_000 });
    expect(store.getItem(itemId)!.landedCommit).not.toBeNull();

    // The active documents disappear before the restart; the recorded commit
    // already carries the closed copies, so they are not needed again.
    rmSync(doc);
    rmSync(doc.replace(/_plan\.md$/, '_spec_planned.md'));
    landing.hangPromotion = false;
    await restart();
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
    expect(git(['ls-tree', '-r', '--name-only', 'main'])).toContain('docs/plans/2026-01-01-alpha_plan_completed.md');
    expect(git(['log', '--format=%s', 'main']).split('\n').filter((line) => line.startsWith('Plan: '))).toHaveLength(1);
  });

  it('rebuilds a recorded landing commit, documents included, when the base moved before it was promoted', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    landing.hangPromotion = true;
    const { run } = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', config: { postMergeGate: [] },
    });
    const itemId = coordinator.getRunDto(run.id)!.items[0].id;
    await vi.waitFor(() => { if (!landing.hung) throw new Error('promotion not reached'); }, { timeout: 30_000 });
    const stale = store.getItem(itemId)!.landedCommit;
    expect(stale).not.toBeNull();

    // Someone else lands on main while this process is stuck; the recorded commit is now stale.
    writeFileSync(join(repo, 'other.txt'), 'other\n');
    git(['add', 'other.txt']);
    git(['commit', '-q', '--no-verify', '-m', 'other work']);
    landing.hangPromotion = false;
    await restart();
    await waitForRun(run.id);

    const item = store.getItem(itemId)!;
    expect(item.state).toBe('landed');
    expect(item.landedCommit).not.toBe(stale);
    expect(git(['log', '--format=%s', 'main']).split('\n')).toEqual(['Plan: 2026-01-01-alpha_plan', 'other work', 'base']);
    const landed = git(['show', '--name-only', '--format=', 'main']).split('\n');
    expect(landed).toContain('docs/plans/2026-01-01-alpha_plan_completed.md');
    expect(landed).toContain('docs/plans/2026-01-01-alpha_spec_completed.md');
  });

  it('parks before anything lands when the document cannot be closed', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = (instance, message, f) => {
      // The completed name gets taken while the item is being verified.
      writeDoc('docs/plans/2026-01-01-alpha_plan_completed.md', 'someone else\n');
      return pass(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item.detail).toContain('Nothing was landed');
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });
});


describe('PlanQueueCoordinator — a saved checklist for the folder', { timeout: 30_000 }, () => {
  const saved = (): PlanQueueFolderChecklist => ({ folder: repo, verifierGates: ['npm run saved-check'], postMergeGate: ['npm run saved-merge-check'] });
  const callerGates = { verifierGates: ['echo caller-check'], postMergeGate: ['echo caller-merge'] };
  /** Gates are only declared here; the stubbed runner never executes them. */
  const start = (config?: Parameters<typeof coordinator.startRun>[0]['config']) =>
    coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config });

  beforeEach(() => {
    planDoc('2026-01-01-folder-checklist');
    fake.scripts.worker = never;
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { 'saved-check': 'true', 'saved-merge-check': 'true' } }));
  });

  it('replaces the gates a session passes to plan_queue_start, both the checks and the post-merge commands', async () => {
    setSavedFolderChecklists([saved()]);
    const { run, checklistSetAside } = await start(callerGates);
    expect(checklistSetAside).toBe(true);
    expect(store.getRun(run.id)!.config).toMatchObject({ verifierGates: ['npm run saved-check'], postMergeGate: ['npm run saved-merge-check'] });
  });

  it('applies when the session passes nothing, even where the project would otherwise start with no checks', async () => {
    setSavedFolderChecklists([saved()]);
    const { run, checklistSetAside } = await start();
    expect(checklistSetAside).toBe(false);
    expect(store.getRun(run.id)!.config).toMatchObject({ verifierGates: ['npm run saved-check'], postMergeGate: ['npm run saved-merge-check'] });
  });

  it('lets a session name its own gates when the folder has no saved checklist', async () => {
    setSavedFolderChecklists([{ ...saved(), folder: join(repo, 'elsewhere') }]);
    const { run, checklistSetAside } = await start(callerGates);
    expect(checklistSetAside).toBe(false);
    expect(store.getRun(run.id)!.config).toMatchObject(callerGates);
  });

  it('applies an entry for the sub-folder the run was started in, and ignores one for a sub-folder it was not', async () => {
    const sub = join(repo, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    setSavedFolderChecklists([{ ...saved(), folder: sub }]);
    const started = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', workspaceCwd: sub });
    expect(store.getRun(started.run.id)!.config).toMatchObject({ verifierGates: ['npm run saved-check'], postMergeGate: ['npm run saved-merge-check'] });
    const other = await start(callerGates);
    expect(other.checklistSetAside).toBe(false);
    expect(store.getRun(other.run.id)!.config).toMatchObject(callerGates);
  });

  it('keeps the saved gates on the stored run, so a later edit of the list does not change a run already started', async () => {
    setSavedFolderChecklists([saved()]);
    const { run } = await start(callerGates);
    setSavedFolderChecklists([]);
    expect(store.getRun(run.id)!.config.verifierGates).toEqual(['npm run saved-check']);
    expect(coordinator.getRun(run.id).config.postMergeGate).toEqual(['npm run saved-merge-check']);
  });
});
