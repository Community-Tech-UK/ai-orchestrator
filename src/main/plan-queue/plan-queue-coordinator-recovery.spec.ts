import { execFileSync } from 'node:child_process';
import { HarnessStopError } from '../../shared/utils/harness-stop';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { getLogger } from '../logging/logger';
import { WorktreeManager } from '../workspace/git/worktree-manager';
import { buildOrchestratorToolsMcpConfig } from '../mcp/orchestrator-tools-mcp-config';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { PlanQueueRelaxation } from './plan-queue-relaxation';
import { recordWorkerReport } from './plan-queue-worker-report';
import { landing } from './plan-queue-coordinator.test-mocks';
import {
  repo,
  driver,
  store,
  fake,
  coordinator,
  git,
  FakeInstances,
  writeDoc,
  planDoc,
  implement,
  itemIdOf,
  pass,
  triageAllReady,
  waitForRun,
  startCoordinator,
  never,
  restart,
  waitForState,
  setFake,
  setCoordinator,
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

describe('PlanQueueCoordinator — boot recovery', { timeout: 30_000 }, () => {
  it.each([
    { label: 'records a checked port for a livetest item that had none', hadPort: false },
    { label: 'keeps the port a livetest item already had, without re-checking it', hadPort: true },
  ])('after a restart, $label', async ({ hadPort }) => {
    writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# L\n');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    await waitForState(0, run.id, 'working');
    const itemId = coordinator.getRunDto(run.id)!.items[0].id;
    // The worker that died may still hold its dev app's port; a check-free would wrongly move the item off it.
    // Any free port does: a fixed one collides when full runs overlap on a machine.
    const holder = hadPort ? net.createServer() : null;
    await new Promise<void>((resolve, reject) => { if (!holder) return resolve(); holder.once('error', reject); holder.listen({ port: 0, host: '127.0.0.1' }, resolve); });
    // As if the app died before the port was saved (null), or with it saved (a number).
    const recorded = holder ? (holder.address() as net.AddressInfo).port : null;
    store.upsertItem({ ...store.getItem(itemId)!, livetestPort: recorded });
    try {
      // The respawned worker stays idle: the test ends as soon as it exists, and a worker that kept
      // building would write into a working folder the teardown has already removed.
      const next = await restart(null, { scripts: { worker: never } });
      await vi.waitFor(() => { if (!next.created.some((i) => i.role === 'worker')) throw new Error('no respawned worker yet'); }, { timeout: 15_000, interval: 25 });
      verifyRestartPort(next);
    } finally { await new Promise<void>((resolve) => { if (!holder) return resolve(); holder.close(() => resolve()); }); }

    function verifyRestartPort(next: FakeInstances): void {
      const port = store.getItem(itemId)!.livetestPort;
      if (recorded === null) {
        expect(port).toBeGreaterThanOrEqual(9500);
        expect(port).toBeLessThan(9900);
      } else expect(port).toBe(recorded);
      expect(next.created.find((i) => i.role === 'worker')!.config.initialPrompt).toContain(`--remote-debugging-port=${port}`);
    }
  });

  describe('a turn Harness stopped on purpose (Decision 16a)', () => {
    /** The provider error a Codex round raises when it passes its token ceiling. */
    const stoppedByHarness: Script = (instance, _message, instances) => {
      instances.emit('provider:normalized-event', {
        eventId: 'e', seq: 0, timestamp: 0, provider: 'codex', instanceId: instance.id,
        event: {
          kind: 'error', recoverable: false, message: 'Stopped by Harness: this turn passed 300M tokens.',
          details: { stoppedByHarness: { reason: 'turn-token-ceiling', tokens: 301_000_000, thresholdTokens: 300_000_000 } },
        },
      });
    };

    it('parks the worker as stopped-by-harness without starting a replacement or a checker', async () => {
      planDoc('2026-01-01-alpha');
      const parent = fake.addParent();
      fake.scripts.worker = stoppedByHarness;

      const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
      await waitForRun(run.id);

      expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({
        state: 'parked', parkReason: 'stopped-by-harness', detail: expect.stringContaining('Stopped by Harness: this turn passed 300M tokens.'),
      });
      expect(fake.created.filter((i) => i.role === 'worker')).toHaveLength(1);
      expect(fake.created.filter((i) => i.role === 'verifier')).toHaveLength(0);
    });

    it('does not start a replacement worker when a fix-round send fails with the stop', async () => {
      planDoc('2026-01-01-alpha');
      const parent = fake.addParent();
      let verifications = 0;
      fake.scripts.verifier = (instance) => {
        verifications += 1;
        coordinator.reportVerdict(instance.id, {
          item_id: itemIdOf(instance), verdict: 'FAIL',
          findings: [{ severity: 'medium', confidence: 70, summary: 'Needs another round.' }], gates_run: [], document_complete: true, need_james: [], not_checked: [],
        });
      };
      let workerTurns = 0;
      fake.scripts.worker = (instance, message, instances) => {
        workerTurns += 1;
        return workerTurns === 1 ? implement(instance, message, instances) : stoppedByHarness(instance, message, instances);
      };
      const send = fake.sendInput.bind(fake);
      // The real adapter ends the failed send with the typed stop error.
      fake.sendInput = async (id, message, attachments, options) => {
        await send(id, message, attachments, options);
        if (fake.getInstance(id)?.role === 'worker') {
          throw new HarnessStopError({ reason: 'turn-token-ceiling', tokens: 301_000_000, thresholdTokens: 300_000_000 });
        }
      };

      const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 3 } });
      await waitForRun(run.id);

      expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'stopped-by-harness' });
      expect(fake.created.filter((i) => i.role === 'worker')).toHaveLength(1);
      expect(verifications).toBe(1);
    });

    it('parks a stopped checker instead of counting an errored round and trying again', async () => {
      planDoc('2026-01-01-alpha');
      const parent = fake.addParent();
      fake.scripts.verifier = stoppedByHarness;

      const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
      await waitForRun(run.id);

      expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'stopped-by-harness', erroredRounds: 0 });
      expect(fake.created.filter((i) => i.role === 'verifier')).toHaveLength(1);
    });

    it('parks a stopped readiness check on the first stop rather than retrying it', async () => {
      planDoc('2026-01-01-alpha');
      const parent = fake.addParent();
      fake.scripts.triage = stoppedByHarness;

      const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
      await waitForRun(run.id);

      expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'stopped-by-harness' });
      expect(fake.created.filter((i) => i.role === 'triage')).toHaveLength(1);
    });
  });
  it('respawns a worker for a working item whose session died, keeping its pre-restart work', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = async (instance, message, f) => {
      await implement(instance, message, f);
      await never(instance, message, f);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    const next = await restart();
    await waitForRun(run.id);

    const newWorker = next.created.find((i) => i.role === 'worker')!;
    expect(newWorker.config.initialPrompt).toContain('the app restarted');
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
    expect(git(['show', 'main:2026-01-01-alpha_plan.feature.txt'])).toBe('built 2026-01-01-alpha_plan');
  });

  it('finishes parking a job Harness stopped when the app ended mid-park, without respawning its worker', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    // The first step of parking a Harness stop is to record it; the app then ended before the rest happened.
    store.upsertItem({ ...store.getItem(run.items[0].id)!, parkReason: 'stopped-by-harness', detail: 'Stopped by Harness: this turn passed 300M tokens.' });

    const next = await restart();
    await vi.waitFor(() => expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('parked'), { timeout: 15_000, interval: 25 });

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ parkReason: 'stopped-by-harness', detail: expect.stringContaining('300M tokens') });
    expect(next.created.filter((i) => i.role === 'worker')).toHaveLength(0);
  });

  it('follows a parent restored under a new id: adopts the respawned worker and nests and reports to it', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    // As in the app: recovery respawns the worker before the parent is restored.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const held: Script = async (instance, message, f) => {
      await implement(instance, message, f);
      await released;
    };
    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: held } });
    const worker = next.created.find((i) => i.role === 'worker')!;
    expect(worker.config.parentId).toBeUndefined();

    // No scheduler pass: the restored parent is followed the moment it appears.
    const restored = next.restoreParent(parent);

    expect(restored.id).not.toBe(parent.id);
    expect(store.getRun(run.id)!.parentInstanceId).toBe(restored.id);
    expect(next.adoptions).toEqual([{ childId: worker.id, parentId: restored.id }]);

    release();
    await waitForRun(run.id);
    expect(next.created.find((i) => i.role === 'verifier')!.config.parentId).toBe(restored.id);
    expect(next.inputs.some((input) => input.instanceId === restored.id && input.internalSource === 'plan-queue')).toBe(true);
  });

  it('records the parent\'s thread and finds the restored parent by it after a crash archived nothing', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    expect(store.getRun(run.id)!.parentHistoryThreadId).toBe(parent.historyThreadId);
    await waitForState(0, run.id, 'working');

    const next = await restart(null, { parentRestoredLater: true, parentArchived: false, scripts: { worker: never } });
    const worker = next.created.find((i) => i.role === 'worker')!;
    const restored = next.restoreParent(parent);

    expect(store.getRun(run.id)!.parentInstanceId).toBe(restored.id);
    expect(next.adoptions).toEqual([{ childId: worker.id, parentId: restored.id }]);
  });

  it('finds the parent of a run recorded without a thread through history, then records the thread', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    driver.prepare('UPDATE plan_queue_runs SET parent_history_thread_id = NULL').run();

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    const restored = next.restoreParent(parent);

    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: restored.id, parentHistoryThreadId: parent.historyThreadId });
  });

  it('keeps the recorded thread current when the parent starts a fresh thread, and still finds it after a restart', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    // "Restart fresh" keeps the session id and mints a new thread.
    parent.historyThreadId = 'thread-after-fresh-restart';
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)!.parentHistoryThreadId).toBe('thread-after-fresh-restart');

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    const restored = next.restoreParent(parent);
    expect(store.getRun(run.id)!.parentInstanceId).toBe(restored.id);
  });

  it('falls back to the history archived from the old id when the recorded thread is stale', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    // The thread moved after the last follow, just before shutdown.
    parent.historyThreadId = 'thread-moved-at-shutdown';

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    const restored = next.restoreParent(parent);

    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: restored.id, parentHistoryThreadId: 'thread-moved-at-shutdown' });
  });

  it('moves the run and its sessions to the replacement when the parent is edited and resent', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.parentId).toBe(parent.id);

    // Edit-and-resend, in the app's order: the replacement appears on the
    // same thread, then the source (kept in memory, hidden) is superseded.
    const replacement = fake.restoreParent(parent);
    expect(store.getRun(run.id)!.parentInstanceId).toBe(parent.id);
    fake.setStatus(parent, 'superseded');

    expect(store.getRun(run.id)!.parentInstanceId).toBe(replacement.id);
    expect(fake.adoptions).toEqual([{ childId: worker.id, parentId: replacement.id }]);
    await coordinator.control({ action: 'pause', runId: run.id }, replacement.id);
    expect(coordinator.getRunDto(run.id)!.status).toBe('paused');
  });

  it('finds the edit replacement on the source\'s current thread when the recorded one is stale', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    // Restart fresh, then an edit-and-resend with no follow in between to
    // record the new thread (the replacement is not announced here).
    parent.historyThreadId = 'thread-after-fresh-restart';
    const replacement = fake.addParent();
    replacement.historyThreadId = parent.historyThreadId;
    fake.setStatus(parent, 'superseded');

    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: replacement.id, parentHistoryThreadId: 'thread-after-fresh-restart' });
  });

  it('accepts control from a parent restored under a new id', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    const restored = next.restoreParent(parent);
    await coordinator.control({ action: 'pause', runId: run.id }, restored.id);

    expect(coordinator.getRunDto(run.id)).toMatchObject({ status: 'paused', parentInstanceId: restored.id });
  });

  it('follows the restored parent without re-saving a stale run snapshot', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    // A spawn path holds this snapshot across awaits while James pauses the run.
    const stale = store.getRun(run.id)!;
    await coordinator.control({ action: 'pause', runId: run.id });
    const restored = next.restoreParent(parent);

    expect(coordinator.liveParentId(stale)).toBe(restored.id);
    expect(store.getRun(run.id)).toMatchObject({ status: 'paused', parentInstanceId: restored.id });
  });

  it('keeps a run whose parent was not restored on the recorded parent, its sessions unparented', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    next.addParent(); // an unrelated session: a different conversation thread
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();

    expect(store.getRun(run.id)!.parentInstanceId).toBe(parent.id);
    expect(next.adoptions).toEqual([]);
  });

  it('re-verifies an item that was verifying with a fresh verifier, discarding the dead verifier\'s edits', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = async (instance, message, f) => {
      // The verifier breaks the rules and then the app dies mid-verification.
      writeFileSync(join(instance.workingDirectory!, 'a.txt'), 'verifier edit\n');
      writeFileSync(join(instance.workingDirectory!, 'verifier-scratch.txt'), 'x\n');
      execFileSync('git', ['add', 'verifier-scratch.txt'], { cwd: instance.workingDirectory! });
      await never(instance, message, f);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'verifying');

    const next = await restart();
    await waitForRun(run.id);
    expect(next.created.filter((i) => i.role === 'verifier')).toHaveLength(1);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', erroredRounds: 0 });
    expect(git(['show', 'main:a.txt'])).toBe('base');
    expect(git(['ls-tree', '--name-only', 'main'])).not.toContain('verifier-scratch.txt');
    expect(git(['ls-tree', '--name-only', 'main'])).toContain('2026-01-01-alpha_plan.feature.txt');
  });

  it('defers a recovered verifier until orchestrator tools are listening (LT-700)', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'verifying');

    let release!: () => void;
    const listening = new Promise<void>((resolve) => { release = resolve; });
    await Promise.race([
      coordinator._whenSettledForTesting(),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    fake.live.clear();
    PlanQueueCoordinator._resetForTesting();
    WorktreeManager._resetForTesting();
    const next = new FakeInstances();
    next.scripts.triage = triageAllReady;
    next.scripts.worker = implement;
    next.scripts.verifier = pass;
    next.live.set(parent.id, { ...parent, outputBuffer: [] });
    setFake(next);
    setCoordinator(startCoordinator(next, null, { whenOrchestratorToolsListening: () => listening }));
    const recovering = coordinator.recover();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(next.created.filter((instance) => instance.role === 'verifier')).toHaveLength(0);

    release();
    await recovering;
    await vi.waitFor(() => {
      expect(next.created.filter((instance) => instance.role === 'verifier')).toHaveLength(1);
    }, { timeout: 15_000, interval: 25 });
    const verifier = next.created.find((instance) => instance.role === 'verifier')!;
    const mcp = buildOrchestratorToolsMcpConfig({
      aioMcpCliPath: '/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp',
      socketPath: '/tmp/harness/ot-test.sock',
      instanceId: verifier.id,
      capabilityToken: 'cap-test-token',
      provider: verifier.provider,
      exists: () => true,
    });
    expect(mcp).toContain('"orchestrator"');
    expect(mcp).toContain('orchestrator-tools');
    expect(mcp).toContain('/tmp/harness/ot-test.sock');
    expect(mcp).toContain(verifier.id);
  });

  it('resumes an interrupted landing', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    landing.hang = true;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    // The "crashed" process must really be stuck inside the landing call.
    await vi.waitFor(() => { if (!landing.hung) throw new Error('landing not reached'); }, { timeout: 15_000 });

    landing.hang = false;
    await restart();
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
    expect(git(['log', '--format=%s', 'main']).split('\n').filter((line) => line.startsWith('Plan: '))).toHaveLength(1);
  });

  it('prepares a worktree for an item that died in preparing, re-triages discovered items, and leaves questions open', async () => {
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    writeDoc('docs/plans/2026-01-03-orphan_plan.md', '**Spec:** [s](./missing_spec_planned.md)\n');
    const parent = fake.addParent();
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', config: { postMergeGate: [] },
    });
    const [alpha] = coordinator.getRunDto(run.id)!.items;
    // Simulate a crash straight after alpha's row moved to preparing.
    store.upsertItem({ ...store.getItem(alpha.id)!, state: 'queued' });
    store.upsertItem({ ...store.getItem(alpha.id)!, state: 'preparing' });

    const pending = store.getItem(run.items[2].id)!;
    store.upsertItem({ ...pending, state: 'needs-answer', question: {
      question: 'Which human-owned account should this campaign use?',
      options: [{ id: 'proceed', label: 'Account A' }, { id: 'skip', label: 'Leave it' }],
      decision: { kind: 'human-input', reason: 'The account is not specified in available sources.' },
    } });

    const next = await restart();
    await waitForState(0, run.id, 'landed');
    await waitForState(1, run.id, 'landed');
    expect(next.created.filter((i) => i.role === 'triage')).toHaveLength(1);
    expect(coordinator.getRunDto(run.id)!.items[2].state).toBe('needs-answer');
    expect(coordinator.getRunDto(run.id)!.status).toBe('running');
  });

  it('keeps settings relaxed while any relaxed run is active, handing the true originals to the run that outlives the first', async () => {
    const values = new Map<string, unknown>([['computerUseAutonomyLevel', 'guarded'], ['providersExcludedFromAutomation', ['copilot']]]);
    const relaxation = new PlanQueueRelaxation({ get: (k) => values.get(k), set: (k, v) => { values.set(k, v); } });
    PlanQueueCoordinator._resetForTesting();
    setCoordinator(startCoordinator(fake, relaxation));
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    let releaseBeta!: () => void;
    const betaGate = new Promise<void>((done) => { releaseBeta = done; });
    fake.scripts.worker = async (instance, message, f) => {
      if (instance.workingDirectory!.includes('beta')) await betaGate;
      await implement(instance, message, f);
    };

    const audit = vi.spyOn(getLogger('PlanQueueItemFlow'), 'info');
    const first = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-01-*', config: { relaxSettings: true },
    });
    const second = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-02-*', config: { relaxSettings: true },
    });
    expect(store.getRun(second.run.id)!.relaxation).toBeNull();
    expect(second.run.relaxedSettings).toEqual(['computerUseAutonomyLevel', 'providersExcludedFromAutomation']);
    // The sharing run holds no snapshot, but its workers are audited as running relaxed too.
    await vi.waitFor(() => {
      const audited = audit.mock.calls
        .filter(([message]) => message === 'Plan queue worker runs under relaxed settings')
        .map(([, data]) => (data as { runId: string }).runId);
      if (!audited.includes(second.run.id)) throw new Error('sharing run not audited yet');
    }, { timeout: 10_000 });
    audit.mockRestore();

    await waitForRun(first.run.id);
    // The second run is still working: its relaxation must still be in force.
    expect(values.get('computerUseAutonomyLevel')).toBe('unrestricted');
    expect(store.getRun(second.run.id)!.relaxation?.entries.map((e) => e.original)).toEqual(['guarded', ['copilot']]);
    expect(store.getRun(first.run.id)!.relaxation).toBeNull();

    releaseBeta();
    await waitForRun(second.run.id);
    expect(values.get('computerUseAutonomyLevel')).toBe('guarded');
    expect(values.get('providersExcludedFromAutomation')).toEqual(['copilot']);
  });

  it('hands the snapshot to a paused relaxed run when the holder is cancelled, and restores when that run ends', async () => {
    const values = new Map<string, unknown>([['computerUseAutonomyLevel', 'guarded'], ['providersExcludedFromAutomation', ['copilot']]]);
    const relaxation = new PlanQueueRelaxation({ get: (k) => values.get(k), set: (k, v) => { values.set(k, v); } });
    PlanQueueCoordinator._resetForTesting();
    setCoordinator(startCoordinator(fake, relaxation));
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const holder = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-01-*', config: { relaxSettings: true } });
    const heir = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-02-*', config: { relaxSettings: true } });
    await coordinator.control({ action: 'pause', runId: heir.run.id });

    await coordinator.control({ action: 'cancel', runId: holder.run.id });

    expect(values.get('computerUseAutonomyLevel')).toBe('unrestricted');
    expect(store.getRun(heir.run.id)!.relaxation?.entries.map((e) => e.original)).toEqual(['guarded', ['copilot']]);
    await coordinator.control({ action: 'cancel', runId: heir.run.id });
    expect(values.get('computerUseAutonomyLevel')).toBe('guarded');
    expect(values.get('providersExcludedFromAutomation')).toEqual(['copilot']);
  });

  it('after a restart with two relaxed runs active, exactly one holds the true originals', async () => {
    const values = new Map<string, unknown>([['computerUseAutonomyLevel', 'guarded'], ['providersExcludedFromAutomation', ['copilot']]]);
    const relaxation = new PlanQueueRelaxation({ get: (k) => values.get(k), set: (k, v) => { values.set(k, v); } });
    PlanQueueCoordinator._resetForTesting();
    setCoordinator(startCoordinator(fake, relaxation));
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const first = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-01-*', config: { relaxSettings: true } });
    const second = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-02-*', config: { relaxSettings: true } });
    await waitForState(0, first.run.id, 'working');
    await waitForState(0, second.run.id, 'working');

    await restart(relaxation);

    const holders = [first.run.id, second.run.id].map((id) => store.getRun(id)!.relaxation).filter(Boolean);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.entries.map((e) => e.original)).toEqual(['guarded', ['copilot']]);
    expect(values.get('computerUseAutonomyLevel')).toBe('unrestricted');
    await coordinator.control({ action: 'cancel', runId: first.run.id });
    await coordinator.control({ action: 'cancel', runId: second.run.id });
    expect(values.get('computerUseAutonomyLevel')).toBe('guarded');
  });

  it('restores relaxed settings on boot and re-applies them for a run that is still active', async () => {
    const values = new Map<string, unknown>([['computerUseAutonomyLevel', 'guarded'], ['providersExcludedFromAutomation', ['copilot']]]);
    const relaxation = new PlanQueueRelaxation({ get: (k) => values.get(k), set: (k, v) => { values.set(k, v); } });
    PlanQueueCoordinator._resetForTesting();
    setCoordinator(startCoordinator(fake, relaxation));
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { relaxSettings: true } });
    expect(values.get('computerUseAutonomyLevel')).toBe('unrestricted');
    expect(store.getRun(run.id)!.relaxation?.entries.map((e) => e.original)).toEqual(['guarded', ['copilot']]);
    await waitForState(0, run.id, 'working');

    await restart(relaxation);
    expect(values.get('computerUseAutonomyLevel')).toBe('unrestricted');
    await waitForRun(run.id);
    expect(values.get('computerUseAutonomyLevel')).toBe('guarded');
    expect(values.get('providersExcludedFromAutomation')).toEqual(['copilot']);
    expect(store.getRun(run.id)!.relaxation).toBeNull();
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
  });
});


describe('PlanQueueCoordinator — a worker respawn proves its work folder first', { timeout: 30_000 }, () => {
  it('parks instead of starting a worker when the saved folder was replaced by a plain directory', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = async (instance, _message, f) => {
      f.say(instance, 'Should the retention period be 30 or 90 days?');
      f.setStatus(instance, 'waiting_for_input');
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await vi.waitFor(() => { if (!coordinator.getRunDto(run.id)!.items[0].question) throw new Error('no question yet'); }, { timeout: 15_000, interval: 25 });
    const item = store.listItems(run.id)[0];
    // The worker's session is gone and its folder is now a plain directory inside the root checkout.
    fake.live.delete(item.workerInstanceId!);
    rmSync(item.worktreePath!, { recursive: true, force: true });
    mkdirSync(item.worktreePath!, { recursive: true });
    const workersBefore = fake.created.filter((i) => i.role === 'worker').length;

    await coordinator.answer(item.id, 'continue');
    await coordinator._whenSettledForTesting();

    expect(fake.created.filter((i) => i.role === 'worker')).toHaveLength(workersBefore);
    expect(store.getItem(item.id)).toMatchObject({ state: 'parked', parkReason: 'worktree-error' });
    expect(store.getItem(item.id)?.detail).toContain("isn't this job's own folder");
  });
});


describe('PlanQueueCoordinator deferred checks and finding kinds (step 5.2)', { timeout: 30_000 }, () => {
  const DEFERRED = { title: 'Each provider calls the report tool', steps: 'Start a run on each provider.', expectedResult: 'Each reports.', whyDeferred: 'Needs a rebuilt app.' };
  const STEM = '2026-01-01-alpha';
  const verdictArgs = (instance: FakeInstance, extra: Record<string, unknown>) => ({
    item_id: itemIdOf(instance), verdict: 'PASS' as const, findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [], ...extra,
  });
  const failWith = (findings: Array<Record<string, unknown>>): Script => (instance) => {
    coordinator.reportVerdict(instance.id, verdictArgs(instance, { verdict: 'FAIL', findings }) as Parameters<typeof coordinator.reportVerdict>[1]);
  };
  const passDeferring = (titles: string[], criteriaTotal: number): Script => (instance) => {
    coordinator.reportVerdict(instance.id, verdictArgs(instance, {
      deferred_checks: titles.map((title) => ({ title, whyDeferred: 'Needs a rebuilt app.' })), criteria_total: criteriaTotal,
    }) as Parameters<typeof coordinator.reportVerdict>[1]);
  };
  /** A worker that reports its deferred checks, and writes them beside the plan when asked to. */
  const deferringWorker = (options: { writeLivetest?: boolean; report?: boolean } = {}): Script => (instance, message, f) => {
    implement(instance, message, f);
    if (options.report !== false) {
      recordWorkerReport(coordinator, instance.id, { item_id: itemIdOf(instance), summary: 'Built it.', as_built: 'Done.', checks_run: [], deferred_checks: [DEFERRED], follow_ups: [] });
    }
    if (options.writeLivetest !== false) writeDoc(`docs/plans/${STEM}_plan_livetest.md`, `# Live checks\n\n## ${DEFERRED.title}\n\nSteps: ${DEFERRED.steps}\n`);
  };
  const workers = () => fake.created.filter((i) => i.role === 'worker');
  const item0 = (runId: string) => coordinator.getRunDto(runId)!.items[0];
  const startPlans = async () => {
    planDoc(STEM);
    return (await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' })).run;
  };

  it('refuses PASS with document_complete false for a plan, and says what to do instead', async () => {
    let refusal = '';
    fake.scripts.verifier = (instance, message, f) => {
      try { coordinator.reportVerdict(instance.id, verdictArgs(instance, { document_complete: false }) as Parameters<typeof coordinator.reportVerdict>[1]); } catch (error) { refusal = (error as Error).message; }
      pass(instance, message, f);
    };
    const run = await startPlans();
    await waitForRun(run.id);
    expect(refusal).toMatch(/always closed/);
    expect(refusal).toMatch(/report FAIL with findings/);
    expect(refusal).toMatch(/deferred_checks/);
    expect(item0(run.id).state).toBe('landed');
    expect(existsSync(join(repo, `docs/plans/${STEM}_plan_completed.md`))).toBe(true);
  });

  it('still lets a livetest pass with checks open and its document left under its active name', async () => {
    const doc = writeDoc('docs/plans/2026-01-01-beta_livetest.md', '# Livetest\n\n- [ ] check 1\n');
    fake.scripts.verifier = (instance) => {
      coordinator.reportVerdict(instance.id, verdictArgs(instance, { document_complete: false,
        need_james: [{ check: 'Check 2: Face ID unlock', classification: 'real', reason: 'Needs a physical iPhone.' }] }) as Parameters<typeof coordinator.reportVerdict>[1]);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'livetests' });
    await waitForRun(run.id);
    expect(item0(run.id).state).toBe('landed');
    expect(existsSync(doc)).toBe(true);
  });

  it('refuses, through the verdict tool, a non-code finding that names nothing missing and deferred checks without a total', async () => {
    const refusals: string[] = [];
    fake.scripts.verifier = (instance, message, f) => {
      const attempt = (extra: Record<string, unknown>) => {
        try { coordinator.reportVerdict(instance.id, verdictArgs(instance, extra) as Parameters<typeof coordinator.reportVerdict>[1]); } catch (error) { refusals.push((error as Error).message); }
      };
      attempt({ verdict: 'FAIL', findings: [{ severity: 'high', kind: 'needs-human', confidence: 90, summary: 'Needs someone.' }] });
      attempt({ deferred_checks: [{ title: 'a', whyDeferred: 'b' }] });
      pass(instance, message, f);
    };
    const run = await startPlans();
    await waitForRun(run.id);
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toContain('exact missing thing');
    expect(refusals[1]).toContain('criteria_total');
    expect(item0(run.id).state).toBe('landed');
  });

  it('lands a plan with deferred checks that are reported and written down, and closes the document', async () => {
    fake.scripts.worker = deferringWorker();
    fake.scripts.verifier = passDeferring([DEFERRED.title], 4);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id)).toMatchObject({ state: 'landed', verdict: { verdict: 'PASS', deferredChecks: [{ title: DEFERRED.title }], criteriaTotal: 4 } });
    expect(existsSync(join(repo, `docs/plans/${STEM}_plan_completed.md`))).toBe(true);
  });

  it('turns a PASS into a FAIL when a deferred check is not in the worker\'s report, and the next round lands it', async () => {
    let turn = 0;
    fake.scripts.worker = (instance, message, f) => { turn += 1; return deferringWorker({ report: turn > 1 })(instance, message, f); };
    fake.scripts.verifier = passDeferring([DEFERRED.title], 4);
    const run = await startPlans();
    await waitForRun(run.id);
    const rows = store.getItem(run.items[0].id)!;
    expect(rows.state).toBe('landed');
    expect(fake.created.filter((i) => i.role === 'verifier')).toHaveLength(2);
    expect(workers()).toHaveLength(1);
    const fixPrompt = fake.inputs.filter((m) => m.instanceId === workers()[0].id).map((m) => m.message).find((m) => m.includes('An independent verifier failed your work'))!;
    expect(fixPrompt).toContain('does not list');
    expect(fixPrompt).toContain(DEFERRED.title);
  });

  it('turns a PASS into a FAIL when the livetest document does not hold the deferred check', async () => {
    let turn = 0;
    fake.scripts.worker = (instance, message, f) => { turn += 1; return deferringWorker({ writeLivetest: turn > 1 })(instance, message, f); };
    fake.scripts.verifier = passDeferring([DEFERRED.title], 4);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id).state).toBe('landed');
    const fixPrompt = fake.inputs.map((m) => m.message).find((m) => m.includes('An independent verifier failed your work'))!;
    expect(fixPrompt).toContain('No livetest document was found');
    expect(workers()).toHaveLength(1);
  });

  it('sets a PASS aside for James, unmerged, when more than half of the criteria are deferred', async () => {
    fake.scripts.worker = deferringWorker();
    fake.scripts.verifier = passDeferring([DEFERRED.title], 1);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id)).toMatchObject({ state: 'parked', parkReason: 'needs-james' });
    expect(item0(run.id).detail).toContain('1 of 1 acceptance criteria');
    expect(existsSync(join(repo, `docs/plans/${STEM}_plan.md`))).toBe(true);
    expect(git(['log', '--oneline', 'main']).split('\n')).toHaveLength(1);
  });

  it('lands a PASS that defers exactly half of its criteria', async () => {
    fake.scripts.worker = deferringWorker();
    fake.scripts.verifier = passDeferring([DEFERRED.title], 2);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id).state).toBe('landed');
  });

  it('sets a FAIL aside as needs-setup, with no new worker round, when every finding is an environment problem', async () => {
    fake.scripts.verifier = failWith([{ severity: 'high', kind: 'environment', confidence: 95, summary: 'The signing gate cannot run here.', missing: 'The CODESIGN_IDENTITY variable' }]);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id)).toMatchObject({ state: 'parked', parkReason: 'needs-setup', round: 1 });
    expect(item0(run.id).detail).toContain('The CODESIGN_IDENTITY variable');
    expect(item0(run.id).verdict?.findings[0].kind).toBe('environment');
    expect(workers()).toHaveLength(1);
    expect(fake.inputs.filter((m) => m.instanceId === workers()[0].id)).toHaveLength(0);
  });

  it('sets a FAIL aside as needs-james when a finding needs a human', async () => {
    fake.scripts.verifier = failWith([
      { severity: 'high', kind: 'environment', confidence: 90, summary: 'No test device.', missing: 'A paired iPhone' },
      { severity: 'high', kind: 'needs-human', confidence: 90, summary: 'The release needs a decision.', missing: 'James\'s approval to publish' },
    ]);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id)).toMatchObject({ state: 'parked', parkReason: 'needs-james' });
    expect(item0(run.id).detail).toContain('James\'s approval to publish');
    expect(item0(run.id).detail).toContain('A paired iPhone');
    expect(workers()).toHaveLength(1);
  });

  it('keeps the fix round when any finding is code, and tells the worker the others are not its to fix', async () => {
    let round = 0;
    fake.scripts.verifier = (instance, message, f) => {
      round += 1;
      if (round > 1) { pass(instance, message, f); return; }
      failWith([
        { severity: 'high', kind: 'code', confidence: 90, summary: 'The counter is never reset.' },
        { severity: 'medium', kind: 'environment', confidence: 90, summary: 'The signing gate cannot run.', missing: 'The signing certificate' },
      ])(instance, message, f);
    };
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id).state).toBe('landed');
    const fixPrompt = fake.inputs.map((m) => m.message).find((m) => m.includes('An independent verifier failed your work'))!;
    expect(fixPrompt).toContain('environment: needs The signing certificate');
    expect(fixPrompt).toContain('do not work around it');
  });

  it('reads a FAIL finding with no kind as a code finding, as stored verdicts from before kinds do', async () => {
    let round = 0;
    fake.scripts.verifier = (instance, message, f) => {
      round += 1;
      if (round > 1) { pass(instance, message, f); return; }
      failWith([{ severity: 'high', confidence: 90, summary: 'The counter is never reset.' }])(instance, message, f);
    };
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id).state).toBe('landed');
    expect(workers()).toHaveLength(1);
    expect(store.getItem(run.items[0].id)!.round).toBe(2);
    // The verdict is stored with the kind filled in.
    expect(store.history.listVerdicts(run.items[0].id)[0].findings.map((f) => f.kind)).toEqual(['code']);
  });

  it('keeps a needs-setup stop across a restart, starts no worker for it, and Resume sends it back to a worker', async () => {
    fake.scripts.verifier = failWith([{ severity: 'high', kind: 'environment', confidence: 95, summary: 'The gate cannot run here.', missing: 'Node 22 on the PATH' }]);
    const run = await startPlans();
    await waitForRun(run.id);
    const itemId = run.items[0].id;
    const parentId = fake.created.find((i) => i.role === 'parent')!.id;
    expect(item0(run.id)).toMatchObject({ state: 'parked', parkReason: 'needs-setup' });
    const next = await restart();
    await waitForRun(run.id);
    expect(store.getItem(itemId)).toMatchObject({ state: 'parked', parkReason: 'needs-setup' });
    expect(next.created.filter((i) => i.role === 'worker' || i.role === 'verifier')).toHaveLength(0);
    next.scripts.verifier = pass;
    await coordinator.control({ action: 'resume-item', itemId }, parentId);
    await waitForRun(run.id);
    expect(store.getItem(itemId)!.state).toBe('landed');
  });

  it('replays stored PASS verdicts with needJames entries and no finding kinds', async () => {
    const doc = writeDoc('docs/plans/2026-01-01-gamma_livetest.md', '# Livetest\n\n- [ ] check 1\n');
    fake.scripts.verifier = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'livetests' });
    // Wait for the verifier session too: the coordinator saves the item again once it exists, and under load that
    // late save overwrote the stored verdict below, so the restart re-verified instead of replaying it.
    await vi.waitFor(() => {
      expect(store.getItem(run.items[0].id)!.state).toBe('verifying');
      expect(fake.created.some((i) => i.role === 'verifier')).toBe(true);
      expect(store.getItem(run.items[0].id)!.verifierInstanceId).toBeTruthy();
    }, { timeout: 15_000, interval: 25 });
    // What an earlier app version stored: no `kind` on a finding, no deferred checks, open checks classified.
    const stored = JSON.parse(JSON.stringify({
      verdict: 'PASS', findings: [{ severity: 'low', confidence: 70, summary: 'A note from before kinds existed.' }], gatesRun: [], documentComplete: false,
      needJames: [{ check: 'Check 2: Face ID unlock', classification: 'real', reason: 'Needs a physical iPhone.' },
        { check: 'Check 3: Computer Use click', classification: 'policy-gated', reason: 'Blocked by a setting.' }],
      notChecked: [],
    }));
    store.upsertItem({ ...store.getItem(run.items[0].id)!, state: 'landing', verdict: stored });
    const next = await restart();
    next.scripts.verifier = pass;
    await waitForRun(run.id);
    const dto = item0(run.id);
    expect(dto.state).toBe('landed');
    expect(dto.verdict?.needJames).toHaveLength(2);
    expect(dto.verdict?.findings[0].kind).toBeUndefined();
    expect(existsSync(doc)).toBe(true);
    expect(existsSync(doc.replace('_livetest.md', '_livetest_completed.md'))).toBe(false);
  });
});
