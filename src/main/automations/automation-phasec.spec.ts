import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createTables, createMigrationsTable, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { CatchUpCoordinator } from './catch-up-coordinator';
import { normalizedMonitorOutput } from './automation-monitor';
import { AutomationRunner } from './automation-runner';
import { createAutomationToolDefinitions } from '../mcp/orchestrator-automation-tools';
import type { InstanceManager } from '../instance/instance-manager';
import type { AutomationAttachmentService } from './automation-attachment-service';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { AutomationAction } from '../../shared/types/automation.types';

const output = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => output.dir } }));
vi.mock('../session/artifact-attribution-store', () => ({ getArtifactAttributionStore: () => ({ registerArtifact: vi.fn() }) }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('./automation-account-rules', () => ({ automationAccountPreferences: async () => undefined }));
vi.mock('../channels/channel-manager', () => ({ getChannelManager: () => ({ getAdapter: () => undefined }) }));

describe('scheduled job execution contract', () => {
  let db: ReturnType<typeof defaultDriverFactory>;
  let store: AutomationStore;
  let clock: number;
  interface TestInstance { id: string; parentId: string | null; childrenIds: string[]; status?: string; outputBuffer?: { type: string; content: string; timestamp: number }[]; metadata?: Record<string, unknown> }
  let manager: EventEmitter & { createInstance: ReturnType<typeof vi.fn>; getInstance: (id: string) => TestInstance | undefined; getAllInstances: () => TestInstance[]; terminateInstance: ReturnType<typeof vi.fn>; queueInstanceUpdate: ReturnType<typeof vi.fn> };
  let runner: AutomationRunner;
  let runs: Map<string, TestInstance>;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 10_000;
    output.dir = mkdtempSync(join(process.cwd(), '_scratch', 'automation-phasec-'));
    db = defaultDriverFactory(':memory:');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined,
      listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
    runs = new Map();
    manager = Object.assign(new EventEmitter(), {
      createInstance: vi.fn(async (config: InstanceCreateConfig) => {
        const instance = { id: 'root', parentId: null, childrenIds: [], status: 'busy', outputBuffer: [], metadata: config.metadata };
        runs.set(instance.id, instance);
        return instance;
      }),
      getInstance: (id: string) => runs.get(id), getAllInstances: () => [...runs.values()],
      terminateInstance: vi.fn(async (id: string) => { runs.delete(id); }), queueInstanceUpdate: vi.fn(),
    });
    runner = new AutomationRunner(store, undefined, () => clock, (() => ({})) as never,
      undefined, undefined, () => ({ automationDefaultCli: 'claude', automationDefaultModel: 'sonnet', modelPickerFavorites: [] }));
    runner.initialize(manager as unknown as InstanceManager);
  });
  afterEach(() => { vi.useRealTimers(); db.close(); rmSync(output.dir, { recursive: true, force: true }); });
  async function fire(action: Partial<AutomationAction> & { maxRunMinutes?: number; maxProcessedTokens?: number } = {}) {
    const automation = await store.create({ name: 'Check server', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      action: { prompt: 'Check server', workingDirectory: '/repo', ...action } }, 600_000, clock);
    await runner.fire(automation.id, { trigger: 'manual' });
    return automation;
  }
  function event(kind: string, extra = {}, id = 'root') {
    manager.emit('provider:normalized-event', { instanceId: id, event: { kind, ...extra } });
  }
  it('persists safe defaults on new jobs', async () => {
    const a = await fire();
    expect(a.action).toMatchObject({ maxRunMinutes: 90, maxProcessedTokens: 30_000_000 });
  });
  it('stops the whole tree at the deadline, keeps partial output and never retries', async () => {
    const retry = vi.fn(); runner.setRetryScheduler(retry);
    const a = await fire({ maxRunMinutes: 1 });
    runs.set('child', { id: 'child', parentId: 'root', childrenIds: ['grandchild'] });
    runs.set('grandchild', { id: 'grandchild', parentId: 'child', childrenIds: [] });
    event('output', { messageType: 'assistant', content: 'Partial work' });
    clock += 60_000; await vi.advanceTimersByTimeAsync(60_000);
    event('complete');
    const run = store.listRuns({ automationId: a.id })[0];
    expect(run).toMatchObject({ status: 'failed', error: 'Stopped after 1 minutes', outputSummary: 'Partial work' });
    expect(run.outputFullRef).toBeTruthy();
    expect(manager.terminateInstance.mock.calls.map((c: string[]) => c[0]).sort()).toEqual(['child', 'grandchild', 'root']);
    expect(retry).not.toHaveBeenCalled();
  });
  it('counts descendant input and both caches before accepting root success', async () => {
    const a = await fire({ maxProcessedTokens: 100 });
    runs.set('child', { id: 'child', parentId: 'root', childrenIds: [] });
    event('complete', { inputTokens: 20, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 31 }, 'child');
    event('output', { messageType: 'assistant', content: 'Done' }); event('complete');
    expect(store.listRuns({ automationId: a.id })[0]).toMatchObject({ status: 'failed', error: 'Stopped: token cap' });
  });
  it('checks elapsed time on completion even when the timer has not run', async () => {
    const a = await fire({ maxRunMinutes: 1 });
    clock += 60_001;
    event('output', { messageType: 'assistant', content: 'Late success' }); event('complete');
    expect(store.listRuns({ automationId: a.id })[0].status).toBe('failed');
  });
  it('fails a completed empty turn, while prose mentioning failure is still successful', async () => {
    const a = await fire(); event('complete');
    expect(store.listRuns({ automationId: a.id })[0]).toMatchObject({ status: 'failed', error: 'No result or assistant text was returned' });
    const b = await fire(); event('output', { messageType: 'assistant', content: 'The earlier failure has been resolved.' }); event('complete');
    expect(store.listRuns({ automationId: b.id })[0].status).toBe('succeeded');
  });
  it('accepts a semantic quiet result through the production tool before any output', async () => {
    const a = await fire();
    const tool = createAutomationToolDefinitions({ instanceId: 'root', automationResult: (result, meta) =>
      runner.recordResult(meta.callerInstanceId, result) }).find(t => t.name === 'automation_result');
    expect(tool).toBeDefined();
    await tool!.handler({ outcome: 'no_change', notify: false }); event('complete');
    expect(store.listRuns({ automationId: a.id })[0]).toMatchObject({ status: 'succeeded', result: { outcome: 'no_change', notify: false } });
  });
  it('recovers an unchanged one-time prompt once without losing the interrupted attempt', async () => {
    const a = await store.create({ name: 'Once', schedule: { type: 'oneTime', runAt: clock + 1_000 },
      action: { prompt: 'Finish report', workingDirectory: '/repo' } }, clock + 1_000, clock);
    const first = store.decideAndInsertRun(a, 'scheduled', clock + 1_000, clock);
    expect(first.kind).toBe('started');
    clock += 2_000;
    const fresh = new AutomationRunner(store, undefined, () => clock, (() => ({})) as never);
    fresh.initialize(manager as unknown as InstanceManager);
    const interrupted = store.listRuns({ automationId: a.id })[0];
    expect(interrupted).toMatchObject({ status: 'failed', error: 'Interrupted by an app restart' });
    expect(store.listPendingRetries()).toHaveLength(1);
    expect((await store.get(a.id))?.nextFireAt).toBeGreaterThan(clock);
    expect((await store.get(a.id))?.consecutiveFailures).toBe(0);
    const retry = store.insertRetryRun(interrupted, 2, 2, clock + 15_000, clock);
    expect(retry?.configSnapshot?.action.prompt).toContain('check what it already did');
    const again = new AutomationRunner(store, undefined, () => clock, (() => ({})) as never);
    again.initialize(manager as unknown as InstanceManager);
    expect(store.listPendingRetries()).toHaveLength(0);
  });
  it.each(['disabled', 'changed', 'delivered', 'system'] as const)('does not restart %s work', async (kind) => {
    const a = await fire();
    const run = store.listRuns({ automationId: a.id })[0];
    if (kind === 'disabled') await store.update(a.id, { enabled: false }, null, clock);
    if (kind === 'changed') await store.update(a.id, { action: { ...a.action, prompt: 'Different task' } }, undefined, clock);
    if (kind === 'delivered') store.markDeliveryStarted(run.id, clock);
    if (kind === 'system') db.prepare(`UPDATE automation_runs SET config_snapshot_json = json_set(config_snapshot_json,
      '$.action.systemAction', json('{"type":"instanceProviderLimitResume","instanceId":"example"}')) WHERE id = ?`).run(run.id);
    const fresh = new AutomationRunner(store, undefined, () => clock, (() => ({})) as never);
    fresh.initialize(manager as unknown as InstanceManager);
    expect(store.listPendingRetries()).toHaveLength(0);
  });

  it('doubles opted-in unchanged checks to 4x and resets immediately on changed output', async () => {
    const a = await fire({ slowWhenUnchanged: true });
    const complete = (text: string) => { event('output', { messageType: 'assistant', content: text }); event('complete'); };
    complete('Server healthy at 2026-10-01 10:20:30, duration 10ms, id abc-123');
    clock += 600_000;
    await runner.fire(a.id, { trigger: 'manual' });
    complete('Server healthy at 2026-10-02 11:21:31, duration 20ms, id xyz-456');
    // Finishes ten seconds after a cron tick; backoff must stay on nominal ticks.
    expect(await store.get(a.id)).toMatchObject({ nextFireAt: 1_800_000, monitorState: { unchangedChecks: 2, intervalMultiplier: 2 } });
    clock += 1_200_000;
    await runner.fire(a.id, { trigger: 'manual' }); complete('Server healthy at 2026-10-03 12:22:32, duration 30ms, id qwe-789');
    expect(await store.get(a.id)).toMatchObject({ nextFireAt: 4_200_000, monitorState: { unchangedChecks: 3, intervalMultiplier: 4 } });
    clock += 600_000;
    await runner.fire(a.id, { trigger: 'manual' }); complete('Server has a new warning');
    expect(await store.get(a.id)).toMatchObject({ nextFireAt: 3_000_000, monitorState: { unchangedChecks: 1, intervalMultiplier: 1 } });
  });
  it('counts only consecutive semantic quiet runs for a dismissible model hint', async () => {
    const a = await fire();
    for (let i = 0; i < 10; i++) {
      if (i) await runner.fire(a.id, { trigger: 'manual' });
      runner.recordResult('root', { outcome: 'no_change', notify: false }); event('complete');
    }
    expect(await store.get(a.id)).toMatchObject({ monitorState: { quietRuns: 10, modelHintDismissed: false } });
    store.dismissModelHint(a.id);
    expect(await store.get(a.id)).toMatchObject({ monitorState: { modelHintDismissed: true } });
    await runner.fire(a.id, { trigger: 'manual' }); event('output', { messageType: 'assistant', content: 'Nothing changed' }); event('complete');
    expect(await store.get(a.id)).toMatchObject({ monitorState: { quietRuns: 0 } });
    expect((await store.get(a.id))?.action.model).toBeUndefined();
  });

  it('normalizes local dates, compact durations and equals-style IDs but preserves status changes', () => {
    expect(normalizedMonitorOutput('Healthy 31/10/2026 duration 3s id=abc-123')).toBe('Healthy <date> duration <duration> id <id>');
    expect(normalizedMonitorOutput('Healthy November 1, 2026 duration 4s id=def-456')).toBe('Healthy <date> duration <duration> id <id>');
    expect(normalizedMonitorOutput('HTTP 503, 12 warnings')).not.toBe(normalizedMonitorOutput('HTTP 200, 0 warnings'));
  });

  it('keeps enforcing the cap after the root finishes while a child is still working', async () => {
    const a = await fire({ maxProcessedTokens: 100 });
    runs.set('child', { id: 'child', parentId: 'root', childrenIds: [], status: 'busy' });
    event('output', { messageType: 'assistant', content: 'Root finished' }); event('complete', { inputTokens: 20 });
    expect(store.listRuns({ automationId: a.id })[0].status).toBe('running');
    event('complete', { inputTokens: 81 }, 'child');
    expect(store.listRuns({ automationId: a.id })[0]).toMatchObject({ status: 'failed', error: 'Stopped: token cap' });
  });

  it('keeps processed usage when a paused run attaches again', async () => {
    const a = await fire({ maxProcessedTokens: 100 });
    runs.set('child', { id: 'child', parentId: 'root', childrenIds: [], status: 'busy' });
    event('complete', { inputTokens: 60 }, 'child');
    const run = store.listRuns({ automationId: a.id })[0];
    runner.pauseRunForGlobalPause(run.id); runner.resumeRunForGlobalPause(run.id, 'root');
    event('complete', { cacheReadTokens: 41 }, 'child');
    expect(store.listRuns({ automationId: a.id })[0]).toMatchObject({ status: 'failed', error: 'Stopped: token cap' });
  });
  it('compares all the returned output when choosing whether to slow down', async () => {
    const a = await fire({ slowWhenUnchanged: true });
    const sameHead = 'Unchanged details '.repeat(300);
    event('output', { messageType: 'assistant', content: `${sameHead} Healthy` }); event('complete');
    await runner.fire(a.id, { trigger: 'manual' });
    event('output', { messageType: 'assistant', content: `${sameHead} Warning` }); event('complete');
    expect(await store.get(a.id)).toMatchObject({ monitorState: { unchangedChecks: 1, intervalMultiplier: 1 } });
  });

  it('waits for settled completion after a clean process exit, then fails an empty turn', async () => {
    const a = await fire(); event('exit', { code: 0 });
    expect(store.listRuns({ automationId: a.id })[0].status).toBe('running');
    event('complete');
    expect(store.listRuns({ automationId: a.id })[0]).toMatchObject({ status: 'failed', error: 'No result or assistant text was returned' });
  });
  it('tells a session whose run already ended that its result cannot be recorded, and why', async () => {
    const a = await fire();
    // A held call shown to a person: the run ends needing approval, but the session lives on and may report after Allow.
    manager.emit('instance:input-required', { instanceId: 'root', requestId: 'ask', metadata: { type: 'deferred_permission', tool_name: 'mcp__orchestrator__plan_queue_start' } });
    expect(store.listRuns({ automationId: a.id })[0]).toMatchObject({ status: 'failed', error: 'Automation requires unattended permission approval' });
    expect(() => runner.recordResult('root', { outcome: 'done', notify: true }))
      .toThrow('This scheduled run has already ended (failed: Automation requires unattended permission approval), so Harness cannot record its result');
  });
  it('does not repeat work which already reported a completed semantic result', async () => {
    const a = await fire(); runner.recordResult('root', { outcome: 'done', notify: true });
    const fresh = new AutomationRunner(store, undefined, () => clock, (() => ({})) as never);
    fresh.initialize(manager as unknown as InstanceManager);
    expect(store.listPendingRetries()).toHaveLength(0);
    expect(store.listRuns({ automationId: a.id })[0]).toMatchObject({ result: { outcome: 'done', notify: true } });
  });

  it('expires while waiting to dispatch and cannot spawn later when the hold ends', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fresh = new AutomationRunner(store, undefined, () => clock, (() => ({})) as never,
      undefined, undefined, undefined, undefined, async (_run, _store, dispatch) => { entered(); await held; await dispatch(); });
    fresh.initialize(manager as unknown as InstanceManager);
    const action = { prompt: 'Work', workingDirectory: '/repo', maxRunMinutes: 1 };
    const a = await store.create({ name: 'Held', schedule: { type: 'oneTime', runAt: clock + 1000 }, action }, clock + 1000, clock);
    const firing = fresh.fire(a.id, { trigger: 'manual' }); await started;
    clock += 60_001; await vi.advanceTimersByTimeAsync(60_001);
    expect(store.listRuns({ automationId: a.id })[0]).toMatchObject({ status: 'failed', error: 'Stopped after 1 minutes' });
    release!(); await firing;
    expect(manager.createInstance).not.toHaveBeenCalled();
  });

  it('does not let missed-run handling consume a restored one-time restart retry', async () => {
    const a = await store.create({ name: 'Once', schedule: { type: 'oneTime', runAt: clock + 1_000 },
      action: { prompt: 'Finish report', workingDirectory: '/repo' } }, clock + 1_000, clock);
    store.decideAndInsertRun(a, 'manual', clock, clock);
    clock += 2_000;
    const fresh = new AutomationRunner(store, undefined, () => clock, (() => ({})) as never);
    fresh.initialize(manager as unknown as InstanceManager);
    await new CatchUpCoordinator(store, fresh, undefined, () => clock).runStartupSweep();
    expect(store.listPendingRetries()).toHaveLength(1);
    expect(await store.get(a.id)).toMatchObject({ active: true, nextFireAt: clock + 15_000 });
    expect(store.listRuns({ automationId: a.id })).toHaveLength(1);
  });

});
