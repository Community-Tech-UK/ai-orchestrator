import type { AutomationTrigger } from '../../shared/types/automation.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { AutomationCheckStore } from './automation-check-store';
import { AutomationRunner } from './automation-runner';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { QUIET_RUN_SENTINEL } from './automation-run-quiet';
import { InstanceManager } from '../instance/instance-manager';
import { describeCheckStatsLine } from '../../renderer/app/features/automations/automation-run-display';
const state = vi.hoisted(() => ({ directory: '/tmp/inert-automation-stats', checkStore: null as AutomationCheckStore | null }));
vi.mock('electron', () => ({ app: { getPath: () => state.directory, isPackaged: false }, Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('./automation-check-store', async (importOriginal) => ({ ...await importOriginal<typeof import('./automation-check-store')>(), getAutomationCheckStore: () => state.checkStore }));
vi.mock('../process/resource-governor', () => ({ getResourceGovernor: () => ({ getCreationBlockReason: () => 'inert fixture capacity' }) }));
// Checks run through plain `/bin/sh -c`, not the developer's login shell: its profile start-up follows the
// computer's load and timed these tests out on a busy Mac. The login shell is covered by automation-pre-check.spec.ts.
vi.mock('../orchestration/loop-completion-detector', async (importOriginal) => ({ ...await importOriginal<typeof import('../orchestration/loop-completion-detector')>(), buildVerifyInvocation: (command: string) => ({ file: '/bin/sh', args: ['-c', command], useShellOption: false }) }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../channels/channel-manager', () => ({ getChannelManager: () => ({ getAdapter: vi.fn(), emitResponseSent: vi.fn() }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }) }));
vi.mock('../commands/command-manager', () => ({ getCommandManager: vi.fn() }));
vi.mock('../core/system/session-policy-log', () => ({ recordSessionPolicy: vi.fn() }));
vi.mock('../orchestration/task-manager', () => ({ getTaskManager: () => ({ stopTimeoutChecker: vi.fn() }) }));
vi.mock('../session/handoff-state-service', () => ({ getHandoffStateService: () => ({ removeInstance: vi.fn() }) }));
let db: SqliteDriver;
let store: AutomationStore;
let checks: AutomationCheckStore;
beforeEach(() => { resetAutomationEventsForTesting(); state.directory = mkdtempSync(join(tmpdir(), 'aio-automation-stats-')); db = defaultDriverFactory(':memory:'); db.pragma('foreign_keys=ON'); createTables(db); createMigrationsTable(db); runMigrations(db); store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => { }, listForAutomation: async () => [] } as unknown as ConstructorParameters<typeof AutomationStore>[1]); checks = new AutomationCheckStore(db); state.checkStore = checks; });
afterEach(() => { state.checkStore = null; db.close(); rmSync(state.directory, { recursive: true, force: true }); });
async function fixture(mode = 'attached', command = "printf 'new\\n'", trigger: AutomationTrigger = 'scheduled', check = true) {
    const automation = await store.create({ name: 'Checked fixture job', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, action: { prompt: 'Report change', workingDirectory: '/tmp', provider: 'claude', ...(check ? { preCheck: { command, onError: 'stop' as const } } : {}) } }, 1000, 100);
    const lifecycle = { createInstance: vi.fn() };
    const instances = new Map<string, { id: string; status: string; outputBuffer: { type: string; content: string; timestamp: number }[] }>();
    let seq = 0;
    const manager = Object.assign(new EventEmitter(), { createInstance: vi.fn(async (options: Parameters<InstanceManager['createInstance']>[0]) => { if (mode === 'refused')
            return InstanceManager.prototype.createInstance.call({ lifecycle } as unknown as InstanceManager, options); const instance = { id: 'fixture-' + (++seq), status: mode === 'quiet' ? 'idle' : 'working', outputBuffer: mode === 'quiet' ? [{ type: 'assistant', content: 'Nothing new.\n[[HARNESS:QUIET_RUN]]', timestamp: 1000 }] : [] }; instances.set(instance.id, instance); return instance; }), getInstance: (id: string) => instances.get(id) });
    const runner = new AutomationRunner(store, getAutomationEvents(), () => 1000, undefined, 1, 100, () => ({ automationDefaultCli: 'claude', automationDefaultModel: '', modelPickerFavorites: [] }), undefined, async (_run, _store, dispatch) => dispatch());
    runner.initialize(manager as unknown as Parameters<AutomationRunner['initialize']>[0]);
    const result = await runner.fire(automation.id, { trigger, scheduledAt: 1000 });
    expect(result.run).toBeDefined();
    // A turn settles on the provider's completion event, even when the instance was already idle when attached.
    if (mode === 'quiet') manager.emit('provider:normalized-event', { instanceId: store.getRun(result.run!.id)!.instanceId, event: { kind: 'complete' } });
    return { automation, manager, runner, lifecycle, instances, run: () => store.getRun(result.run!.id)! };
}
const line = (checked: number, started: number) => `Last 1 run: checked ${checked} ${checked === 1 ? 'time' : 'times'}, started the AI ${started} ${started === 1 ? 'time' : 'times'}`;
describe('durable automation rows drive truthful check/start stats', () => {
    it('a real resource-governor refusal after a successful check is not an AI start', async () => { const f = await fixture('refused'); expect(f.run()).toMatchObject({ status: 'failed', outcome: 'first-check', instanceId: null }); expect(f.run().error).toContain('resource governor'); expect(f.lifecycle.createInstance).not.toHaveBeenCalled(); expect(describeCheckStatsLine([f.run()])).toBe(line(1, 0)); });
    it('an actually attached checked instance remains a start after a later failure and removal', async () => { const f = await fixture(); const id = f.run().instanceId!; expect(describeCheckStatsLine([f.run()])).toBe(line(1, 1)); f.manager.emit('provider:normalized-event', { instanceId: id, event: { kind: 'error', message: 'inert provider failure', recoverable: false } }); f.instances.delete(id); f.manager.emit('instance:removed', id); expect(f.run()).toMatchObject({ status: 'failed', instanceId: id }); expect(describeCheckStatsLine([f.run()])).toBe(line(1, 1)); });
    it.each(['manual', 'webhook'] as const)('%s skips its configured check but counts its attached instance', async (trigger) => { const f = await fixture('attached', "printf 'new\\n'", trigger); expect(f.run().outcome).toBeNull(); expect(f.run().instanceId).toBeTruthy(); expect(describeCheckStatsLine([f.run()])).toBe(line(0, 1)); });
    it('a stopped failed check remains checked without starting the AI', async () => { const f = await fixture('attached', 'exit 1'); expect(f.run()).toMatchObject({ status: 'failed', outcome: 'check-failed', instanceId: null }); expect(f.manager.createInstance).not.toHaveBeenCalled(); expect(describeCheckStatsLine([f.run()])).toBe(line(1, 0)); });
    it('scheduled quiet success retains evidence of the check and actual start', async () => { const f = await fixture('quiet'); expect(f.run()).toMatchObject({ status: 'succeeded', outcome: 'quiet', outputSummary: 'Nothing new.' }); expect(f.run().seenAt).not.toBeNull(); expect((await store.get(f.automation.id))?.unreadRunCount).toBe(0); expect(describeCheckStatsLine([f.run()])).toBe(line(1, 1)); });
    it('manual quiet-marker output stays literal and unread without inventing a check', async () => { const f = await fixture('quiet', "printf 'new\\n'", 'manual'); expect(f.run()).toMatchObject({ status: 'succeeded', outcome: null, seenAt: null, outputSummary: `Nothing new.\n${QUIET_RUN_SENTINEL}` }); expect(f.run().instanceId).toBeTruthy(); expect((await store.get(f.automation.id))?.unreadRunCount).toBe(1); expect(describeCheckStatsLine([f.run()])).toBe(line(0, 1)); });
    it('quiet success without a configured check must not invent a check', async () => { const f = await fixture('quiet', "printf 'new\\n'", 'scheduled', false); expect(f.run()).toMatchObject({ status: 'succeeded', outcome: 'quiet' }); expect(describeCheckStatsLine([f.run()])).toBe(line(0, 1)); });
    it('an unchanged subsequent actual check does not start a second AI', async () => { const f = await fixture('quiet'); const second = await f.runner.fire(f.automation.id, { trigger: 'scheduled', scheduledAt: 2000 }); expect(store.getRun(second.run!.id)).toMatchObject({ status: 'skipped', outcome: 'no-change', instanceId: null }); expect(f.manager.createInstance).toHaveBeenCalledTimes(1); expect(describeCheckStatsLine([store.getRun(second.run!.id)!])).toBe(line(1, 0)); });
    it('a retry attaches a new AI but does not run another check', async () => { const f = await fixture(); f.manager.emit('provider:normalized-event', { instanceId: f.run().instanceId, event: { kind: 'error', message: 'inert transient failure', recoverable: false } }); const retry = store.insertRetryRun(f.run(), 2, 2, 2000, 2000)!; await f.runner.dispatchRetryRun(retry); const row = store.getRun(retry.id)!; expect(row.instanceId).toBeTruthy(); expect(row.outcome).toBeNull(); expect(row.attempt).toBe(2); expect(describeCheckStatsLine([row])).toBe(line(0, 1)); });
});
