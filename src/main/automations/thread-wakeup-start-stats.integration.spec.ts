import { InstanceManager } from '../instance/instance-manager';
import { InstanceCommunicationManager } from '../instance/instance-communication';
import type { InstanceSendInputOptions } from '../instance/instance-input-cancellation';
import { createInstance, type FileAttachment } from '../../shared/types/instance.types';
import { GeminiCliAdapter } from '../cli/adapters/gemini-cli-adapter';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { AdmissionOutcome, RedeliveryHandler } from '../session/session-admission-service';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { describeCheckStatsLine } from '../../renderer/app/features/automations/automation-run-display';
const state = vi.hoisted(() => ({ directory: '/tmp/inert-automation-stats', redelivery: (() => { throw new Error('fixture handler was not registered'); }) as RedeliveryHandler, admission: { kind: 'admitted', admissionId: 'inert-admission' } as AdmissionOutcome }));
vi.mock('electron', () => ({ app: { getPath: () => state.directory, isPackaged: false }, Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
import { ThreadWakeupRunner } from './thread-wakeup-runner';
vi.mock('../session/session-admission-service', () => ({ getSessionAdmissionService: () => ({ registerRedeliveryHandler: (_origin: string, handler: RedeliveryHandler) => { state.redelivery = handler; }, admitAutomatedWrite: () => state.admission, recordUserSend: () => null, markDelivered: vi.fn(), markFailed: vi.fn() }) }));
import { createSqliteWasmDatabaseWithExport, openSqliteWasmFileReadOnly } from '../db/sqlite-wasm-driver';
let exportBytes: () => Uint8Array;
let db: SqliteDriver;
let store: AutomationStore;
beforeEach(() => { resetAutomationEventsForTesting(); state.directory = mkdtempSync(join(tmpdir(), 'aio-automation-stats-')); ({ driver: db, exportBytes } = createSqliteWasmDatabaseWithExport()); db.pragma('foreign_keys=ON'); createTables(db); createMigrationsTable(db); runMigrations(db); store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => { }, listForAutomation: async () => [] } as unknown as ConstructorParameters<typeof AutomationStore>[1]); });
afterEach(() => { db.close(); rmSync(state.directory, { recursive: true, force: true }); });
const line = (checked: number, started: number) => `Last 1 run: checked ${checked} ${checked === 1 ? 'time' : 'times'}, started the AI ${started} ${started === 1 ? 'time' : 'times'}`;
async function threadFixture(mode = 'delivered', sendOverride?: (...args: Parameters<InstanceManager['sendInput']>) => Promise<void>) {
    state.admission = mode === 'suppressed' ? { kind: 'suppressed', reason: 'not-ready', admissionId: 'inert-admission' } : { kind: 'admitted', admissionId: 'inert-admission' };
    const destination = { kind: 'thread' as const, instanceId: 'target', reviveIfArchived: false };
    const automation = await store.create({ name: 'Thread job', destination, schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, action: { prompt: 'Check updates', workingDirectory: '/tmp', provider: 'claude', ...(mode === 'already-working' ? { systemAction: { type: 'instanceProviderLimitResume' as const, instanceId: 'target' } } : {}) } }, 1000, 100);
    const decision = store.decideAndInsertRun(automation, 'manual', 1000, 1000);
    if (decision.kind !== 'started')
        throw new Error('fixture run not started');
    if (mode === 'no-send-record-failure') {
        vi.spyOn(store, 'markThreadPromptAttempt').mockImplementation(() => { throw new Error('inert receipt write failure'); });
        state.admission = { kind: 'suppressed', reason: 'not-ready', admissionId: 'inert-admission' };
    }
    if (mode === 'record-failure')
        vi.spyOn(store, 'markThreadPromptDelivered').mockImplementation(() => { throw new Error('inert receipt write failure'); });
    const sendInput = vi.fn(sendOverride ?? (async (_id: string, _message: string, _attachments?: FileAttachment[], options?: InstanceSendInputOptions) => {
        options?.beforeProviderDispatch?.(); if (mode === 'failed')
        throw new Error('inert rejected send'); if (mode === 'busy-race')
        throw new Error('Codex app-server runtime already has an active turn'); options?.onProviderInputDelivered?.(); }));
    const runner = new ThreadWakeupRunner({ sendInput, getInstance: () => ({ status: mode === 'already-working' ? 'busy' : 'idle' }) } as unknown as ConstructorParameters<typeof ThreadWakeupRunner>[0], { revive: async () => ({ status: 'live', instanceId: 'target' }) } as unknown as ConstructorParameters<typeof ThreadWakeupRunner>[1], store, () => 1001);
    await runner.fireThreadWakeup({ run: decision.run, automation, destination });
    return { run: () => store.getRun(decision.run.id)!, sendInput, automation };
}
describe('actual thread delivery evidence', () => {
    it('delivered work is recorded durably and counted once', async () => { const f = await threadFixture(); expect(f.sendInput).toHaveBeenCalledTimes(1); expect(f.run()).toMatchObject({ status: 'succeeded', instanceId: 'target', threadPromptDelivered: true }); expect(describeCheckStatsLine([f.run()])).toBe(line(0, 1)); runMigrations(db); writeFileSync(join(state.directory, 'stats.sqlite'), exportBytes()); db.close(); db = openSqliteWasmFileReadOnly(join(state.directory, 'stats.sqlite')); store = new AutomationStore(db, { listForAutomation: async () => [] } as unknown as ConstructorParameters<typeof AutomationStore>[1]); expect(f.run().threadPromptDelivered).toBe(true); expect(describeCheckStatsLine([f.run()])).toBe(line(0, 1)); });
    it.each(['already-working', 'suppressed'])('%s keeps attachment without counting a start', async (mode) => { const f = await threadFixture(mode); expect(f.run().instanceId).toBe('target'); expect.soft(f.run().threadPromptDelivered).toBe(false); expect(describeCheckStatsLine([f.run()])).toBe(line(0, 0)); expect(f.sendInput).toHaveBeenCalledTimes(0); });
    it('late supported redelivery records a start on the skipped original run', async () => { const f = await threadFixture('suppressed'); const event = vi.fn(); getAutomationEvents().on('automation:run-changed', event); expect(f.run().status).toBe('skipped'); state.redelivery({ admissionId: 'inert-redelivery', instanceId: 'target', message: 'Check updates', sourceMetadata: { runId: f.run().id } }); await vi.waitFor(() => expect(f.run().threadPromptDelivered).toBe(true)); expect(f.run().status).toBe('skipped'); expect(event).toHaveBeenCalledWith(expect.objectContaining({ updateKind: 'delivery-evidence', run: expect.objectContaining({threadPromptDelivered: true}) })); expect(describeCheckStatsLine([f.run()])).toBe(line(0, 1)); });
    it('unrelated redelivery target cannot mutate the run', async () => { const f = await threadFixture('suppressed'); state.redelivery({ admissionId: 'inert-redelivery', instanceId: 'other-target', message: 'Check updates', sourceMetadata: { runId: f.run().id } }); await vi.waitFor(() => expect(f.sendInput).toHaveBeenCalledTimes(1)); await Promise.resolve(); expect.soft(f.run().threadPromptDelivered).toBe(false); });
    it('historical attached thread rows report unknown rather than a false exact count', async () => { const f = await threadFixture('already-working'); const historical = { ...f.run(), threadPromptDelivered: null }; expect(describeCheckStatsLine([historical])).toBe('Last 1 run: checked 0 times, started the AI at least 0 times (1 run could not be confirmed)'); });
    it('historical missing-target failure has no ambiguous attached start', async () => { const f = await threadFixture('failed'); expect(describeCheckStatsLine([{ ...f.run(), instanceId: null, threadPromptDelivered: null }])).toBe(line(0, 0)); });
});
describe('delivery uncertainty never becomes a false definite no-start', () => {
    it.each(['failed', 'record-failure'])('%s retains unknown evidence without changing actual send status', async (mode) => { const f = await threadFixture(mode); expect(f.sendInput).toHaveBeenCalledTimes(1); expect(f.run().threadPromptDelivered).toBeNull(); expect(f.run().status).toBe(mode === 'failed' ? 'failed' : 'succeeded'); expect(describeCheckStatsLine([f.run()])).toBe('Last 1 run: checked 0 times, started the AI at least 0 times (1 run could not be confirmed)'); });
});
describe('nullable delivery evidence controls', () => {
    it('new rows begin unknown, and a failed no-send receipt never invents a definite count', async () => { const f = await threadFixture('no-send-record-failure'); expect(f.sendInput).not.toHaveBeenCalled(); expect(f.run().threadPromptDelivered).toBeNull(); expect(describeCheckStatsLine([f.run()])).toContain('1 run could not be confirmed'); });
    it('the proven active-turn no-write race records false', async () => { const f = await threadFixture('busy-race'); expect(f.sendInput).toHaveBeenCalledTimes(1); expect(f.run()).toMatchObject({ status: 'skipped', threadPromptDelivered: false }); expect(describeCheckStatsLine([f.run()])).toBe(line(0, 0)); });
    it('successful delivery is monotonic across later pending and no-send receipts', async () => { const f = await threadFixture(); store.markThreadPromptAttempt(f.run().id, 'target', false, 2000); store.markThreadPromptAttempt(f.run().id, 'target', true, 2001); expect(f.run().threadPromptDelivered).toBe(true); expect(describeCheckStatsLine([f.run()])).toBe(line(0, 1)); });
    it('an unrelated attempt cannot clear evidence on a different target', async () => { const f = await threadFixture('suppressed'); store.markThreadPromptAttempt(f.run().id, 'other-target'); expect(f.run().threadPromptDelivered).toBe(false); });
    it('failed redelivery is unknown while preserving the skipped lifecycle', async () => { const f = await threadFixture('suppressed'); f.sendInput.mockRejectedValueOnce(new Error('inert ambiguous send rejection')); state.redelivery({ admissionId: 'inert-redelivery', instanceId: 'target', message: 'Check updates', sourceMetadata: { runId: f.run().id } }); await vi.waitFor(() => expect(f.sendInput).toHaveBeenCalledTimes(1)); await Promise.resolve(); expect(f.run()).toMatchObject({ status: 'skipped', threadPromptDelivered: null }); expect(describeCheckStatsLine([f.run()])).toContain('1 run could not be confirmed'); });
});

vi.mock('../instance/instance-lifecycle-hooks', () => ({ assertInstanceLifecycleHookAllowed: async () => {}, dispatchInstanceLifecycleHook: vi.fn() }));
vi.mock('../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));
describe('real manager and communication no-op resolution is not delivery',()=>{
 it.each(['switch-mode','known-limit','accepted'])('%s observes the actual dispatch boundary',async mode=>{
  const instance={id:'target',provider:'claude',currentModel:'fixture',status:'idle',requestCount:0,outputBuffer:[],contextUsage:{},planMode:{enabled:false}};
  const adapterSend=vi.fn(async()=>{});
  const adapter={sendInput:adapterSend};
  const communication={deps:{getInstance:()=>instance,getAdapter:()=>adapter,checkKnownProviderLimitBeforeSend:()=>mode==='known-limit'?'already-parked':'skipped',queueUpdate:vi.fn()},continuityInputQueue:{prepare:()=>({contextBlock:null,commit:vi.fn()})},inputFailureScopes:{open:()=>({activate:vi.fn(),close:vi.fn(),isCurrent:()=>false})},overflow:{rememberLastSent:vi.fn(),rememberDispatch:vi.fn()},toolResultProcessor:{resetAutonomousCount:vi.fn()}};
  const manager={state:{getInstance:()=>instance},emit:vi.fn(),maybeHandleSwitchModeReply:async()=>true};
  const send=async(id:string,message:string,attachments: FileAttachment[] | undefined, options?: InstanceSendInputOptions)=>mode==='switch-mode'?InstanceManager.prototype.sendInput.call(manager as unknown as InstanceManager,id,message,attachments,options):InstanceCommunicationManager.prototype.sendInput.call(communication as unknown as InstanceCommunicationManager,id,message,attachments,null,options);
  const f=await threadFixture('delivered',send);expect(f.run().status).toBe('succeeded');expect(adapterSend).toHaveBeenCalledTimes(mode==='accepted'?1:0);
  if(mode==='accepted')expect(f.run().threadPromptDelivered).toBe(true);else expect(f.run().threadPromptDelivered).not.toBe(true);
 });
});

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }) }));

vi.mock('../commands/command-manager', () => ({ getCommandManager: vi.fn() }));

describe('redelivery evidence freshness',()=>{
 it.each(['ambiguous','no-dispatch'])('%s publishes the changed evidence after an already terminal row',async mode=>{
  const f=await threadFixture('suppressed');const event=vi.fn();getAutomationEvents().on('automation:run-changed',event);
  if(mode==='ambiguous')f.sendInput.mockRejectedValueOnce(new Error('inert ambiguous write'));else f.sendInput.mockImplementationOnce(async()=>{});
  state.redelivery({admissionId:'inert-redelivery',instanceId:'target',message:'Check updates',sourceMetadata:{runId:f.run().id}});
  await vi.waitFor(()=>expect(f.sendInput).toHaveBeenCalledTimes(1));await Promise.resolve();
  expect(event).toHaveBeenCalledWith(expect.objectContaining({updateKind:'delivery-evidence',run:expect.objectContaining({threadPromptDelivered:null})}));
  if(mode==='no-dispatch')expect(event).toHaveBeenLastCalledWith(expect.objectContaining({updateKind:'delivery-evidence',run:expect.objectContaining({threadPromptDelivered:false})}));
 });
});


describe('confirmed native input receipt through migrated automation statistics', () => {
    for (const phase of ['initial', 'redelivery'] as const) {
        it.each(['accepted', 'known-limit', 'parked', 'already-parked', 'switching-account', 'unhandled', 'no-dispatch'] as const)(`${phase}: %s preserves send evidence`, async mode => {
            const instance = createInstance({ workingDirectory: '/tmp', provider: 'gemini' });
            instance.id = 'target';
            instance.status = 'idle';
            const adapter = new GeminiCliAdapter();
            const adapterSend = vi.spyOn(adapter, 'sendInput').mockImplementation(async (_message, _attachments, options) => {
                if (mode === 'no-dispatch') return;
                options?.dispatch?.beforeProviderDispatch?.();
                if (mode !== 'accepted') throw Object.assign(new Error('inert provider refusal'), { quota: { exhausted: true } });
            });
            const park = vi.fn(() => mode === 'parked' || mode === 'already-parked' || mode === 'switching-account' ? mode : 'skipped');
            const communication = new InstanceCommunicationManager({
                getInstance: () => instance, getAdapter: () => adapter,
                setAdapter: () => undefined, deleteAdapter: () => false,
                queueUpdate: () => undefined, processOrchestrationOutput: () => undefined,
                onInterruptedExit: async () => undefined, ingestToRLM: () => undefined,
                ingestToUnifiedMemory: () => undefined,
                checkKnownProviderLimitBeforeSend: () => mode === 'known-limit' ? 'already-parked' : 'skipped',
                onProviderLimitTurn: park,
            });
            let finishSend: () => void = () => undefined;
            const finished = new Promise<void>(resolve => { finishSend = resolve; });
            const send = async (id: string, message: string, attachments: FileAttachment[] | undefined, options?: InstanceSendInputOptions) => {
                try { await communication.sendInput(id, message, attachments, null, options); }
                finally { finishSend(); }
            };
            const f = await threadFixture(phase === 'initial' ? 'delivered' : 'suppressed', send);
            if (phase === 'redelivery') {
                state.redelivery({ admissionId: 'inert-redelivery', instanceId: 'target', message: 'Check updates', sourceMetadata: { runId: f.run().id } });
                await finished;
                await vi.waitFor(() => expect(f.run().threadPromptDelivered).toBe(mode === 'accepted' ? true : mode === 'known-limit' || mode === 'no-dispatch' ? false : null));
            }
            expect(adapterSend).toHaveBeenCalledTimes(mode === 'known-limit' ? 0 : 1);
            expect(f.run().threadPromptDelivered).toBe(mode === 'accepted' ? true : mode === 'known-limit' || mode === 'no-dispatch' ? false : null);
            expect(f.run().status).toBe(phase === 'redelivery' ? 'skipped' : mode === 'unhandled' ? 'failed' : 'succeeded');
            expect(park).toHaveBeenCalledTimes(['parked', 'already-parked', 'switching-account', 'unhandled'].includes(mode) ? 1 : 0);
            if (mode === 'accepted') expect(describeCheckStatsLine([f.run()])).toBe(line(0, 1));
            else if (mode === 'known-limit' || mode === 'no-dispatch') expect(describeCheckStatsLine([f.run()])).toBe(line(0, 0));
            else expect(describeCheckStatsLine([f.run()])).toContain('1 run could not be confirmed');
        });
    }
});
