import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEvent, ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { buildInstanceRecord } from '../instance/lifecycle/instance-create-builder';
import { getDefaultAgent } from '../../shared/types/agent.types';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import { createAutomationToolDefinitions } from '../mcp/orchestrator-automation-tools';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import type { AutomationAttachmentService } from './automation-attachment-service';

const output = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => output.dir } }));
vi.mock('../session/artifact-attribution-store', () => ({ getArtifactAttributionStore: () => ({ registerArtifact: () => undefined }) }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: () => undefined }));
vi.mock('../channels/channel-manager', () => ({ getChannelManager: () => ({ getAdapter: () => undefined }) }));

describe('monitor comparison through typed provider events and the real runner/store', () => {
  let db: ReturnType<typeof defaultDriverFactory>;
  let store: AutomationStore;
  let runner: AutomationRunner;
  let clock: number;
  let instances: Map<string, Instance>;
  let manager: EventEmitter & Pick<InstanceManager, 'createInstance' | 'getInstance' | 'getAllInstances' | 'terminateInstance' | 'queueInstanceUpdate'>;
  let sequence: number;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = Date.UTC(2026, 9, 31, 12);
    vi.setSystemTime(clock);
    sequence = 0;
    output.dir = mkdtempSync(join(process.cwd(), '_scratch', 'authority-monitor-output-'));
    db = defaultDriverFactory(':memory:');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined,
      listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
    resetAutomationEventsForTesting();
    instances = new Map();
    manager = Object.assign(new EventEmitter(), {
      createInstance: async (config: InstanceCreateConfig): Promise<Instance> => {
        const instance = buildInstanceRecord(config, getDefaultAgent(), { defaultYoloMode: false,
          getParent: id => instances.get(id), now: () => clock });
        instance.status = 'busy';
        instance.requestCount = 1;
        instance.adapterGeneration = 7;
        instances.set(instance.id, instance);
        return instance;
      },
      getInstance: (id: string) => instances.get(id), getAllInstances: () => [...instances.values()],
      terminateInstance: async (id: string) => { instances.delete(id); }, queueInstanceUpdate: () => undefined,
    });
    runner = new AutomationRunner(store, getAutomationEvents(), () => clock, undefined, undefined, undefined,
      () => ({ automationDefaultCli: 'claude', automationDefaultModel: 'sonnet', modelPickerFavorites: [] }),
      () => false, async (_run, _store, dispatch) => { await dispatch(); }, async () => undefined);
    runner.initialize(manager as InstanceManager);
  });
  afterEach(() => {
    for (const instance of instances.values()) runner.untrackInstances([instance.id]);
    manager.removeAllListeners();
    resetAutomationEventsForTesting();
    vi.clearAllTimers(); vi.useRealTimers(); db.close();
    rmSync(output.dir, { recursive: true, force: true });
  });
  function emit(instance: Instance, event: ProviderRuntimeEvent) {
    const envelope: ProviderRuntimeEventEnvelope = { eventId: `fixture-event-${++sequence}`, seq: sequence,
      timestamp: clock, provider: 'claude', instanceId: instance.id, adapterGeneration: instance.adapterGeneration, event };
    manager.emit('provider:normalized-event', envelope);
  }
  async function seed(slowWhenUnchanged = true) {
    return store.create({ name: 'Server check', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      action: { prompt: 'Check server', workingDirectory: '/repo', slowWhenUnchanged } }, clock + 600_000, clock);
  }
  async function run(id: string, messages: string[], quiet = false) {
    const fired = await runner.fire(id, { trigger: 'manual', deliveryMode: 'silent' });
    expect(fired.status).toBe('started');
    if (fired.status !== 'started') throw new Error('Expected a started run');
    const attached = store.getRun(fired.run.id)!;
    const instance = instances.get(attached.instanceId!)!;
    expect(attached.status).toBe('running');
    for (const content of messages) emit(instance, { kind: 'output', messageType: 'assistant', content });
    emit(instance, { kind: 'output', messageType: 'tool', content: `Raw tool diagnostic ${sequence}` });
    emit(instance, { kind: 'output', messageType: 'system', content: `Debug trace ${sequence}` });
    if (quiet) await createAutomationToolDefinitions({ instanceId: instance.id,
      automationResult: (result, meta) => runner.recordResult(meta.callerInstanceId, result) })
      .find(tool => tool.name === 'automation_result')!.handler({ outcome: 'no_change', notify: false });
    emit(instance, { kind: 'complete', requestCountAtCompletion: instance.requestCount });
    expect(store.getRun(fired.run.id)).toMatchObject({ status: 'succeeded', finishedAt: clock, outputSummary: messages.at(-1) ?? null });
    clock += 600_000;
    return store.get(id);
  }

  it('resets backoff when an earlier warning changes but the final signoff is identical', async () => {
    const job = await seed();
    await run(job.id, ['Server healthy', 'Finished checking.']);
    expect(await run(job.id, ['Server healthy', 'Finished checking.']))
      .toMatchObject({ monitorState: { unchangedChecks: 2, intervalMultiplier: 2 } });
    expect(await run(job.id, ['Server has a new urgent warning', 'Finished checking.']))
      .toMatchObject({ monitorState: { unchangedChecks: 1, intervalMultiplier: 1, quietRuns: 0 } });
  });

  it('normalizes transient fields across all assistant messages and ignores changing tool/debug noise', async () => {
    const job = await seed();
    await run(job.id, ['Server healthy at 2026-10-01 10:20:30 duration 10ms request_id=abc-123', 'Finished checking.']);
    expect(await run(job.id, ['Server healthy at 2026-10-02 11:21:31 duration 20ms request_id=def-456', 'Finished checking.']))
      .toMatchObject({ monitorState: { unchangedChecks: 2, intervalMultiplier: 2, quietRuns: 0 } });
  });

  it('retains semantic quiet streaks independently of changing assistant findings', async () => {
    const job = await seed();
    await run(job.id, ['Server healthy', 'Finished checking.'], true);
    expect(await run(job.id, ['Server warning', 'Finished checking.'], true))
      .toMatchObject({ monitorState: { unchangedChecks: 1, intervalMultiplier: 1, quietRuns: 2 } });
    expect(await run(job.id, ['Server warning', 'Finished checking.']))
      .toMatchObject({ monitorState: { unchangedChecks: 2, intervalMultiplier: 2, quietRuns: 0 } });
  });

  it('does not opt jobs into slower checks implicitly', async () => {
    const job = await seed(false);
    await run(job.id, ['Server healthy', 'Finished checking.']);
    expect(await run(job.id, ['Server healthy', 'Finished checking.']))
      .toMatchObject({ monitorState: { unchangedChecks: 2, intervalMultiplier: 1 } });
  });
});
