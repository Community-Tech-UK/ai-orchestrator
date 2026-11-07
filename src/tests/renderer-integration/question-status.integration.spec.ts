import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Subject } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeCliAdapter } from '../../main/cli/adapters/claude-cli-adapter';
import { InstanceCommunicationManager } from '../../main/instance/instance-communication';
import { InstancePermissionRequestFlow } from '../../main/instance/instance-permission-request-flow';
import { createInstance } from '../../shared/types/instance.types';
import { InstanceIpcService, IpcEventBusService } from '../../renderer/app/core/services/ipc';
import { StatsIpcService } from '../../renderer/app/core/services/ipc/stats-ipc.service';
import { ProviderStateService } from '../../renderer/app/core/services/provider-state.service';
import { AutomationStore } from '../../renderer/app/core/state/automation.store';
import { InstanceStore } from '../../renderer/app/core/state/instance/instance.store';
import { InstanceListStore } from '../../renderer/app/core/state/instance/instance-list.store';
import { InstanceSelectionStore } from '../../renderer/app/core/state/instance/instance-selection.store';
import { InstanceOutputStore } from '../../renderer/app/core/state/instance/instance-output.store';
import { InstanceMessagingStore } from '../../renderer/app/core/state/instance/instance-messaging.store';
import { InstanceStateService } from '../../renderer/app/core/state/instance/instance-state.service';
import { InstanceRowComponent } from '../../renderer/app/features/instance-list/instance-row.component';
import { RemoteNodeStore } from '../../renderer/app/core/state/remote-node.store';
import { ToolLoopAlertStore } from '../../renderer/app/core/state/tool-loop-alert.store';
import { SideChatStore } from '../../renderer/app/core/state/side-chat.store';
import type { Instance } from '../../renderer/app/core/state/instance/instance.types';
import { projectWorkboard } from '../../renderer/app/features/workboard/workboard-projection';

vi.mock('../../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../main/core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 1000 }) }) }));
vi.mock('../../main/memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../../main/hooks/hook-manager', () => ({ getHookManager: () => ({ triggerLifecycleHooks: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock('../../main/memory/token-stats', () => ({ getTokenStatsService: () => ({ record: vi.fn(), classifyToolType: () => 'other' }) }));
vi.mock('../../main/rlm/token-counter', () => ({ getTokenCounter: () => ({ countTokens: () => 0 }) }));
vi.mock('../../main/instance/instance-permissions-facade', () => ({ loadOptionalProjectRules: vi.fn(),
  mapCliPermissionActionToScope: vi.fn(), normalizeRequestedPath: vi.fn(), toPermissionGateMetadata: vi.fn() }));

await resolveComponentResources(async url => url.endsWith('.html')
  ? readFileSync(resolve('src/renderer/app/features/instance-list', url), 'utf8') : '');
afterEach(() => TestBed.resetTestingModule());

it('keeps a real top-level Claude question out of permission counts through forwarding, batching, row rendering and completion', async () => {
  const streams = Object.fromEntries([
    'batchUpdate$', 'compactStatus$', 'fastToggled$', 'inputRequired$', 'inputRequiredResolved$',
    'instanceCreated$', 'instanceOutput$', 'instanceRemoved$', 'instanceStateUpdate$',
    'inputContextDelivered$', 'instanceTranscriptChunk$', 'orchestrationActivity$', 'yoloToggled$',
  ].map(name => [name, new Subject<unknown>()]));
  TestBed.configureTestingModule({ imports: [InstanceRowComponent], providers: [
    { provide: IpcEventBusService, useValue: streams }, { provide: InstanceIpcService, useValue: {} },
    { provide: StatsIpcService, useValue: { statsRecordToolUsage: vi.fn().mockResolvedValue(undefined) } },
    { provide: ProviderStateService, useValue: {} }, { provide: AutomationStore, useValue: {} },
    { provide: InstanceListStore, useValue: { loadInitialInstances: vi.fn() } },
    { provide: InstanceSelectionStore, useValue: {} },
    { provide: InstanceOutputStore, useValue: { queueOutput: vi.fn(), cleanupAll: vi.fn(), flushInstanceOutput: vi.fn() } },
    { provide: InstanceMessagingStore, useValue: { processMessageQueue: vi.fn() } },
    { provide: Router, useValue: {} }, { provide: RemoteNodeStore, useValue: { nodeById: () => null } },
    { provide: ToolLoopAlertStore, useValue: { hasCriticalAlert: () => false } },
    { provide: SideChatStore, useValue: { attentionFor: () => null } },
  ] });
  const store = TestBed.inject(InstanceStore);
  const state = TestBed.inject(InstanceStateService);
  const adapter = new ClaudeCliAdapter();
  const instance = createInstance({ workingDirectory: '/tmp/example', provider: 'claude' });
  state.state.update(value => ({ ...value, instances: new Map([[instance.id, instance as Instance]]) }));
  const manager = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter,
    setAdapter: vi.fn(), deleteAdapter: vi.fn(), processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn(),
    ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(), getContextEvidenceMode: () => 'off',
    queueUpdate: (instanceId, status) => streams['instanceStateUpdate$'].next({ instanceId, status }) });
  const flow = new InstancePermissionRequestFlow({ getInstance: () => instance, sendInputResponse: vi.fn(),
    resumeAfterDeferredPermission: vi.fn(), addToOutputBuffer: vi.fn(), publishOutput: vi.fn(), getContext: vi.fn(),
    emit: (event, payload) => { if (event === 'instance:input-required') streams['inputRequired$'].next(payload); return true; } });
  manager.on('input-required', payload => { void flow.handleInputRequired(payload); });
  manager.setupAdapterEvents(instance.id, adapter);
  const frame = (message: unknown) => (adapter as unknown as { processCliMessage(message: unknown): void }).processCliMessage(message);
  const fixture = TestBed.createComponent(InstanceRowComponent);
  (fixture.componentInstance as unknown as { instance: () => Instance }).instance = () => store.getInstance(instance.id)!;
  frame({ type: 'tool_use', tool: { id: 'typed-question', name: 'AskUserQuestion', input: { questions: [
    { header: 'Approach', question: 'Which approach?', options: [{ label: 'One' }, { label: 'Two' }] },
  ] } } });
  await vi.waitFor(() => expect(store.getInstance(instance.id)?.status).toBe('waiting_for_input'));
  fixture.detectChanges();
  expect(store.getInstance(instance.id)?.pendingApprovalCount ?? 0).toBe(0);
  expect(fixture.nativeElement.querySelector('.approval-chip')).toBeNull();
  expect(fixture.nativeElement.querySelector('.leading-indicator')?.getAttribute('aria-label')).toContain('Needs your answer');
  frame({ type: 'result', subtype: 'success', result: 'Finished' });
  await vi.waitFor(() => expect(store.getInstance(instance.id)?.status).toBe('idle'));
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('.approval-chip')).toBeNull();
  const board = projectWorkboard({ instances: [store.getInstance(instance.id)!], loopRuns: [], automations: [],
    automationRuns: [], repoJobs: [], now: Date.now() });
  expect(board[0].lane).toBe('done'); expect(board[0].statusLabel).toBe('Ready');
  manager.removeAllListeners(); adapter.removeAllListeners(); fixture.destroy();
});
