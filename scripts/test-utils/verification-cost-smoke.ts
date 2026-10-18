import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import { VerificationAgentCompleteEventSchema, VerificationCompleteEventSchema } from '@contracts/schemas/verification';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import { CliVerificationCoordinator } from '../../src/main/orchestration/cli-verification-extension';
import { setupCoordinatorEvents } from '../../src/main/ipc/cli-verification-event-forwarding';
import { subscribeCostAttribution, type CostAttributionRecord } from '../../src/main/core/system/cost-attribution';
import { VerificationMonitorComponent } from '../../src/renderer/app/features/verification/execution/verification-monitor.component';
import { IpcFacadeService } from '../../src/renderer/app/core/services/ipc';
import { VerificationStore } from '../../src/renderer/app/core/state/verification/verification.store';
import { VerificationConfigStore } from '../../src/renderer/app/core/state/verification/verification-config.store';
import { VerificationSessionStore } from '../../src/renderer/app/core/state/verification/verification-session.store';
import { VerificationStateService } from '../../src/renderer/app/core/state/verification/verification-state.service';
import { DEFAULT_VERIFICATION_CONFIG } from '../../src/renderer/app/core/state/verification/verification.types';

const boundary = vi.hoisted(() => ({ provider: undefined as ProviderAdapter | undefined }));
vi.mock('../../src/main/providers/provider-instance-manager', () => ({ getProviderInstanceManager: () => ({ createCliProvider: () => boundary.provider }) }));
vi.mock('../../src/main/providers/automation-provider-exclusions', () => ({ isProviderExcludedFromAutomation: () => false }));
vi.mock('../../src/main/orchestration/verification-checking-policy', () => ({ createVerificationModelAssigner: () => () => undefined }));
vi.mock('../../src/main/review/copilot-model-entitlements', () => ({ learnFromCheckerFailure: vi.fn() }));

export function registerVerificationCostSmoke(): void {
 describe('CLI verification cost through live IPC and renderer', () => {
  beforeEach(() => {
    CliVerificationCoordinator._resetForTesting();
    TestBed.configureTestingModule({ providers: [
      { provide: IpcFacadeService, useValue: { getApi: () => undefined } },
      { provide: VerificationConfigStore, useValue: { saveStoredState: vi.fn() } },
      { provide: VerificationStore, useFactory: (state: VerificationStateService) => ({
        currentSession: computed(() => state.state().currentSession),
        agentProgressList: computed(() => [...(state.state().currentSession?.agentProgress.values() ?? [])]),
        roundInfo: () => ({ current: 1, total: 1 }), consensusScore: () => 0, isRunning: () => true,
      }), deps: [VerificationStateService] },
    ] });
  });

  afterEach(() => { TestBed.resetTestingModule(); CliVerificationCoordinator._resetForTesting(); });

  it.each([
    { name: 'known paid completion', reported: 0.07, cost: 0.07, display: '$0.0700' },
    { name: 'unknown completion', reported: undefined, cost: 'unknown', display: 'Unknown' },
    { name: 'true zero completion', reported: 0, cost: 0, display: '$0.0000' },
    { name: 'paid provider failure', reported: 0.07, failure: true, cost: 0.07, display: '$0.0700' },
    { name: 'unknown provider failure', reported: undefined, failure: true, cost: 'unknown', display: 'Unknown' },
    { name: 'paid budget stop', reported: 0.07, budget: true, cost: 0.07, display: '$0.0700' },
    { name: 'pre-dispatch failure', reported: undefined, initializeFailure: true, cost: 0, display: '$0.0000' },
  ])('preserves $name in the live monitor and final result', async ({ reported, failure, budget, initializeFailure, cost, display }) => {
    const state = TestBed.inject(VerificationStateService);
    const sessions = TestBed.inject(VerificationSessionStore);
    const coordinator = CliVerificationCoordinator.getInstance();
    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    const events$ = new Subject<ProviderRuntimeEventEnvelope>();
    const event = (event: ProviderRuntimeEventEnvelope['event']) => events$.next({ eventId: `event-${event.kind}`, seq: 1, timestamp: 1, provider: 'codex', instanceId: 'fixture', event, raw: { source: 'fixture', payload: { metadata: { budgetExceeded: budget } } } });
    boundary.provider = {
      events$,
      initialize: async () => { if (initializeFailure) throw new Error('initialize failed'); },
      sendMessage: async () => {
        event({ kind: 'output', content: 'answer' });
        if (reported !== undefined) event({ kind: 'complete', costUsd: reported, inputTokens: 10, outputTokens: 2 });
        if (failure) throw new Error('provider failed');
        event({ kind: 'status', status: 'idle' });
      },
      terminate: async () => undefined,
    } as unknown as ProviderAdapter;
    state.addSession({ id: 'cost-session', prompt: 'verify', config: DEFAULT_VERIFICATION_CONFIG, status: 'running', startedAt: Date.now(), agentProgress: new Map() });
    let liveCost: unknown;
    let finalCost: unknown;
    setupCoordinatorEvents(coordinator, (channel, payload) => {
      if (channel === IPC_CHANNELS.VERIFICATION_AGENT_START) sessions.handleAgentStart(payload as Parameters<VerificationSessionStore['handleAgentStart']>[0]);
      if (channel === IPC_CHANNELS.VERIFICATION_AGENT_COMPLETE) {
        const data = VerificationAgentCompleteEventSchema.parse(payload);
        liveCost = data.response.cost;
        sessions.handleAgentComplete(data);
      }
      if (channel === IPC_CHANNELS.VERIFICATION_COMPLETE) finalCost = VerificationCompleteEventSchema.parse(payload).result.totalCost;
    });
    const fixture = TestBed.createComponent(VerificationMonitorComponent);
    try {
      const result = await coordinator.startVerificationWithCli({ id: 'cost-session', prompt: 'verify' }, { agentCount: 1, cliAgents: ['codex'], timeout: 2000, synthesisStrategy: 'best-of' });
      fixture.componentInstance.selectAgent('cost-session-agent-0');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.stream-meta')?.textContent).toContain(`Cost: ${display}`);
      expect(liveCost).toBe(cost);
      expect(result.responses[0].cost).toBe(cost);
      expect(result.totalCost).toBe(cost);
      expect(finalCost).toBe(cost);
      expect(rows).toHaveLength(initializeFailure ? 0 : 1);
      if (!initializeFailure) expect(rows[0].outcome).toBe(budget ? 'budget-exceeded' : failure ? 'error' : 'success');
      if (failure || budget || initializeFailure) expect(result.responses[0].response).toBe('');
    } finally { stop(); fixture.destroy(); }
  });
});
}
