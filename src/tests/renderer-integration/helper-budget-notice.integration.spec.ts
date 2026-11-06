import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { createSqliteWasmDatabaseWithExport, openSqliteWasmFileReadOnly } from '../../main/db/sqlite-wasm-driver';
import type { SqliteDriver } from '../../main/db/sqlite-driver';
import type { AppSettings } from '../../shared/types/settings.types';
import type { LocalAiGuardSnapshot } from '../../shared/types/local-ai-guard.types';
import type { LocalAiGuardRuntimeOverrides } from '../../main/local-ai-guard/local-ai-runtime';
import { RLM_MIGRATIONS_076_080 } from '../../main/persistence/rlm/rlm-migrations-076-080';
import { RLM_MIGRATIONS_051_055 } from '../../main/persistence/rlm/rlm-migrations-051-055';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import { initializeLocalAiGuardRuntime, _resetLocalAiGuardRuntimeForTesting } from '../../main/local-ai-guard/local-ai-runtime';
import { getNotificationService, resetNotificationService } from '../../main/notifications/notification-service';
import { registerLocalAiGuardHandlers } from '../../main/ipc/handlers/local-ai-guard-handlers';
import { AuxiliaryLlmService } from '../../main/rlm/auxiliary-llm-service';
import { _resetCostAttributionForTesting, reserveAuxiliarySpend } from '../../main/core/system/cost-attribution';
import { LocalAiGuardStore } from '../../renderer/app/core/state/local-ai-guard.store';
import { LocalAiGuardIpcService } from '../../renderer/app/core/services/ipc/local-ai-guard-ipc.service';
import { LocalAiStatusChipComponent } from '../../renderer/app/features/local-ai-guard/local-ai-status-chip.component';
import { getLocalAiAuxiliaryHooks } from '../../main/local-ai-guard/local-ai-auxiliary-bridge';
import { IPC_CHANNELS } from '../../../packages/contracts/src/channels';
const state = vi.hoisted(() => ({ db: null as unknown as SqliteDriver, settings: {} as AppSettings, handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>(), delta: undefined as ((snapshot: LocalAiGuardSnapshot) => void) | undefined, generate: vi.fn(), model: 'gpt-5.5-mini' }));
vi.mock('../../main/persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => state.db }) }));
vi.mock('../../main/core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => state.settings, get: (key: keyof AppSettings) => state.settings[key] }) }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aio-helper-budget-inert', isPackaged: false }, ipcMain: { handle: (key: string, fn: (event: unknown, payload?: unknown) => Promise<unknown>) => state.handlers.set(key, fn), removeHandler: (key: string) => state.handlers.delete(key) }, Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../main/rlm/auxiliary-model-client', () => ({ probeOllamaEndpoint: vi.fn(), listOllamaModels: vi.fn(), generateWithOllama: state.generate, probeOpenAiCompatibleEndpoint: vi.fn(async () => true), listOpenAiCompatibleModels: vi.fn(async () => [{ id: state.model, name: state.model }]), generateWithOpenAiCompatible: state.generate }));
let directory: string;
let cleanup: () => void;
let runtime: ReturnType<typeof initializeLocalAiGuardRuntime>;
let exportBytes: () => Uint8Array;
let store: LocalAiGuardStore;
const notices = () => getNotificationService().list().filter(n => n.body === 'Helper models: daily limit reached. Paid fallbacks resume tomorrow.');
async function setup(cap: number | null, cheap = false, model = 'gpt-5.5-mini') {
    state.model = model;
    state.settings = { ...DEFAULT_SETTINGS, localAiGuardDefaultFallbackPolicy: 'allow-silently', localAiGuardDailyFallbackBudgetUsd: cap, auxiliaryLlmDailySpendCapUsd: cap, auxiliaryLlmRoutingMode: 'manual-only', auxiliaryLlmUseLocalhostOllama: false, auxiliaryLlmAllowRemoteWorkerModels: false, auxiliaryLlmEndpointsJson: JSON.stringify(cheap ? [{ id: 'cheap', label: 'Fixture endpoint', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234', source: 'manual', enabled: true }] : []), auxiliaryLlmSlotsJson: JSON.stringify({ compression: { enabled: true, provider: 'auto', endpointId: cheap ? 'cheap' : 'missing', model, maxInputTokens: 8000, maxOutputTokens: 500, temperature: 0, timeoutMs: 5000, requireJson: false, allowFrontierFallback: true } }) };
    runtime = initializeLocalAiGuardRuntime({ workers: new EventEmitter() as unknown as NonNullable<LocalAiGuardRuntimeOverrides['workers']>, registerCleanup: () => () => undefined });
    // Inject a known paid rung at the routing boundary; the transport is inert.
    Reflect.get(runtime.routing, 'dependencies').resolveFallbackModel = () => ({ provider: 'openai', model: 'gpt-5.5-mini' });
    cleanup = registerLocalAiGuardHandlers({ getRuntime: () => runtime, ensureTrustedSender: () => null, discoverCandidates: async () => [], windowManager: { sendToRenderer: (_channel: string, snapshot: unknown) => state.delta?.(snapshot as LocalAiGuardSnapshot) } });
    TestBed.configureTestingModule({ imports: [LocalAiStatusChipComponent], providers: [LocalAiGuardStore, { provide: Router, useValue: { navigateByUrl: async () => true } }, { provide: LocalAiGuardIpcService, useValue: { getSnapshot: () => state.handlers.get(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT)!({}, undefined) as ReturnType<LocalAiGuardIpcService['getSnapshot']>, onStatusDelta: (fn: (snapshot: LocalAiGuardSnapshot) => void) => { state.delta = fn; return () => { state.delta = undefined; }; } } }] });
    store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    AuxiliaryLlmService._resetForTesting();
    const service = AuxiliaryLlmService.getInstance();
    service.configure(state.settings);
    return service;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T12:00:00Z')); state.generate.mockReset(); state.generate.mockResolvedValue('inert helper response'); state.handlers.clear(); directory = mkdtempSync(join(tmpdir(), 'aio-helper-budget-')); vi.stubEnv('AIO_COST_ATTRIBUTION', '1'); vi.stubEnv('AIO_COST_ATTRIBUTION_DIR', directory); _resetCostAttributionForTesting(); ({ driver: state.db, exportBytes } = createSqliteWasmDatabaseWithExport()); state.db.exec(RLM_MIGRATIONS_051_055.find(m => m.name === '054_local_ai_guard')!.up); state.db.exec('ALTER TABLE local_ai_incidents ADD COLUMN unpriced_dispatch_count INTEGER NOT NULL DEFAULT 0;'); state.db.exec(RLM_MIGRATIONS_076_080.find(m => m.name === '080_helper_budget_notice_day')!.up); });
afterEach(() => { store?.destroy(); cleanup?.(); _resetLocalAiGuardRuntimeForTesting(); resetNotificationService(); state.db?.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); _resetCostAttributionForTesting(); TestBed.resetTestingModule(); vi.useRealTimers(); });
describe('actual helper budget runtime with disposable ledgers', () => {
 it('failed durable notice storage cannot authorize a denied helper or hide the chip',async()=>{const service=await setup(0.000001);state.db.exec('DROP TABLE local_ai_helper_budget_notice');const result=await service.generate('compression','system','summary');expect(result.decision.allowFrontierFallback).toBe(false);expect(state.generate).not.toHaveBeenCalled();expect(runtime.helperBudget).toBeDefined();expect(store.snapshot()?.helperBudget).toBeDefined();expect(notices()).toHaveLength(0);});

 it('same-day recreated runtime and notification service preserve one daily notice while restoring the chip',async()=>{let service=await setup(0.000001);await service.generate('compression','system','summary');const first=notices().length;expect(first).toBe(1);store.destroy();cleanup();_resetLocalAiGuardRuntimeForTesting();resetNotificationService();TestBed.resetTestingModule();writeFileSync(join(directory,'guard.sqlite'),exportBytes());const reopened=openSqliteWasmFileReadOnly(join(directory,'guard.sqlite'));expect(reopened.prepare('SELECT day FROM local_ai_helper_budget_notice').get()).toEqual({day:'2026-10-19'});reopened.close();service=await setup(0.000001);const result=await service.generate('compression','system','summary');expect(result.decision.allowFrontierFallback).toBe(false);expect(state.generate).not.toHaveBeenCalled();expect(store.snapshot()?.helperBudget).toMatchObject({resetsAt:Date.parse('2026-10-20T00:00:00Z')});expect(first+notices().length).toBe(1);await vi.advanceTimersByTimeAsync(12*60*60*1000);expect(store.snapshot()?.helperBudget).toBeUndefined();await service.generate('compression','system','summary');expect(first+notices().length).toBe(2);});


    it('compression global denial keeps basic fallback and publishes one notice and actual bound chip', async () => { const service = await setup(0.000001); for (let i = 0; i < 2; i++) {
        const result = await service.generate('compression', 'system', 'summarize conversation');
        expect(result.text).toBe('');
        expect(result.decision.allowFrontierFallback).toBe(false);
    } expect(state.generate).not.toHaveBeenCalled(); expect(notices()).toHaveLength(1); await Promise.resolve(); const fixture = TestBed.createComponent(LocalAiStatusChipComponent); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('button').textContent).toContain('daily limit reached'); expect(store.snapshot()?.helperBudget).toMatchObject({ resetsAt: Date.parse('2026-10-20T00:00:00Z') }); fixture.destroy(); });
    it('denial reaches actual snapshot and Angular header independently of notice assertion', async () => { const service = await setup(0.000001); await service.generate('compression', 'system', 'summarize'); await Promise.resolve(); const fixture = TestBed.createComponent(LocalAiStatusChipComponent); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('button').textContent).toContain('daily limit reached'); expect(store.snapshot()?.helperBudget).toMatchObject({ resetsAt: Date.parse('2026-10-20T00:00:00Z') }); fixture.destroy(); });
    it('cheap-cloud global denial reaches the same in-app notice without dispatch', async () => { const service = await setup(0.000001, true); const result = await service.generate('compression', 'system', 'summarize conversation'); expect(result.decision.allowFrontierFallback).toBe(false); expect(result.text).toBe(''); expect(state.generate).not.toHaveBeenCalled(); expect(notices()).toHaveLength(1); });
    it('allowed fallback leaves notice and header untouched', async () => { const service = await setup(null); const result = await service.generate('compression', 'system', 'summarize'); expect(result.decision.allowFrontierFallback).toBe(true); expect(notices()).toHaveLength(0); expect(store.snapshot()?.helperBudget ?? null).toBeNull(); });
    it('midnight clears actual snapshot/header without another denial and next day can notify once', async () => { const service = await setup(0.000001); await service.generate('compression', 'system', 'summary'); await Promise.resolve(); const fixture = TestBed.createComponent(LocalAiStatusChipComponent); fixture.detectChanges(); expect(fixture.nativeElement.textContent).toContain('daily limit reached'); const before = store.snapshot()!.revision; await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000); fixture.detectChanges(); expect(store.snapshot()?.helperBudget).toBeUndefined(); expect(store.snapshot()?.revision).not.toBe(before); expect(fixture.nativeElement.textContent).not.toContain('daily limit reached'); expect(notices()).toHaveLength(1); await service.generate('compression', 'system', 'summary'); await service.generate('compression', 'system', 'summary'); expect(notices()).toHaveLength(2); fixture.destroy(); });
    it('approval rechecks a shared cap filled while the actual compression request waits', async () => { const service = await setup(0.01); state.settings.localAiGuardDefaultFallbackPolicy = 'require-confirmation'; const pending = service.generate('compression', 'system', 'summary'); for (let i = 0; i < 10 && !runtime.approvals.listPending().length; i++)
        await Promise.resolve(); const request = runtime.approvals.listPending()[0]; expect(request).toBeDefined(); expect(reserveAuxiliarySpend({ capUsd: 0.01, amountUsd: 0.01, slot: 'compression', provider: 'openai', model: 'gpt-5.5-mini' }).allowed).toBe(true); runtime.approvals.resolve(request.id, 'allow-once'); const result = await pending; expect(result.decision.allowFrontierFallback).toBe(false); expect(notices()).toHaveLength(1); });
    it('a per-target daily ceiling does not claim the global cap was exhausted', async () => { await setup(1); const target = runtime.targets.create({ lifecycle: 'enrolled', location: { type: 'coordinator' }, provider: 'ollama', endpointId: 'fixture', baseUrl: 'http://127.0.0.1:11434', expectedModels: [{ modelId: 'local', required: true }], canary: { model: 'local', timeoutMs: 5000, intervalMs: 120000 }, endpointCheckIntervalMs: 30000, freshnessLimitMs: 60000, warningLatencyMs: 2000, routingRoles: ['compression'], fallbackPolicy: 'allow-silently', slotFallbackPolicies: {}, dailyFallbackBudgetUsd: 0, recovery: { automatic: false, maxAttempts: 1, cooldownMs: 60000 } }); const result = await getLocalAiAuxiliaryHooks().authorizeFallback({ slot: 'compression', slotAllowsFrontier: true, intendedTargetId: target.id, reason: 'fixture unavailable', estimatedInputTokens: 100, estimatedOutputTokens: 500 }); expect(result.allowed).toBe(false); expect(runtime.health.getRoutingEvent(result.routingEventId)?.decisionReason).toBe('daily-budget'); expect(notices()).toHaveLength(0); expect(store.snapshot()?.helperBudget).toBeUndefined(); });
    it('policy/slot denial does not become a global limit notification', async () => { await setup(0); const result = await getLocalAiAuxiliaryHooks().authorizeFallback({ slot: 'compression', slotAllowsFrontier: false, reason: 'unknown-price refusal', estimatedInputTokens: 100, estimatedOutputTokens: 500 }); expect(result.allowed).toBe(false); expect(notices()).toHaveLength(0); });
    it('notification observer failure cannot authorize a blocked paid helper', async () => { const service = await setup(0.000001); const spy = vi.spyOn(getNotificationService(), 'notify').mockImplementation(() => { throw new Error('inert notification failure'); }); try {
        const result = await service.generate('compression', 'system', 'summary');
        expect(result.decision.allowFrontierFallback).toBe(false);
        expect(runtime.helperBudget).toBeDefined();
    }
    finally {
        spy.mockRestore();
    } });
    it('unpriced cheap-cloud refusal does not claim daily exhaustion', async () => { const service = await setup(0.000001, true, 'unpriced-fixture-model'); const result = await service.generate('compression', 'system', 'summary'); expect(result.decision.allowFrontierFallback).toBe(false); expect(result.decision.reason).toContain('no known price'); expect(state.generate).not.toHaveBeenCalled(); expect(notices()).toHaveLength(0); expect(runtime.helperBudget).toBeUndefined(); });
    it('unavailable cost storage refuses cheaply without a false exhaustion notice', async () => { const service = await setup(1, true); vi.stubEnv('AIO_COST_ATTRIBUTION', '0'); const result = await service.generate('compression', 'system', 'summary'); expect(result.decision.allowFrontierFallback).toBe(false); expect(state.generate).not.toHaveBeenCalled(); expect(notices()).toHaveLength(0); expect(runtime.helperBudget).toBeUndefined(); });
    it('allowed cheap-cloud call runs only the inert transport and produces no limit notice', async () => { const service = await setup(1, true); const result = await service.generate('compression', 'system', 'summary'); expect(result.decision.source).toBe('cheap-cloud'); expect(result.text).toBe('inert helper response'); expect(state.generate).toHaveBeenCalledTimes(1); expect(notices()).toHaveLength(0); });
    it('quiet/no-denial does not invent a notice', async () => { await setup(0.000001); expect(notices()).toHaveLength(0); expect(store.snapshot()?.helperBudget ?? null).toBeNull(); });
});
