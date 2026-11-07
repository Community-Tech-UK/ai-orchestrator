import {
  signal,
  ɵresolveComponentResources as resolveComponentResources,
  type WritableSignal,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IpcFacadeService, IpcEventBusService, InstanceIpcService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';
import type { AskAnswerDrafts } from './user-input-request.ask-drafts';
import { PERMISSION_SCOPE_WORDS } from '../../../../shared/permissions/permission-scope-presentation';
import {
  UserActionRequestComponent,
  type UserActionRequest,
} from './user-action-request.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(
  resolve(specDirectory, './user-action-request.component.html'),
  'utf8',
);
const styles = readFileSync(
  resolve(specDirectory, './user-action-request.component.scss'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('user-action-request.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('user-action-request.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('UserActionRequestComponent', () => {
  let fixture: ComponentFixture<UserActionRequestComponent>;
  let onUserActionRequest: (request: unknown) => void;
  let onInputRequired: (payload: {
    instanceId: string;
    requestId: string;
    prompt: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }) => void;
  let currentInstanceId: WritableSignal<string | null>;
  let onInputRequiredResolved: (payload: { instanceId: string; requestId: string; reason: string }) => void;

  const fakeIpc = {
    listUserActionRequests: vi.fn(),
    listUserActionRequestsForInstance: vi.fn(),
    onUserActionRequest: vi.fn(),
    onInputRequired: vi.fn(),
    onInputRequiredResolved: vi.fn(),
    onInstanceRemoved: () => () => undefined,
    onInstanceStateUpdate: () => () => undefined,
    onBatchUpdate: () => () => undefined,
    respondToUserAction: vi.fn(),
    respondToInputRequired: vi.fn(),
    submitSecretCard: vi.fn(),
    declineSecretCard: vi.fn(),
    toggleYoloMode: vi.fn(),
    sendInput: vi.fn(),
  };

  const fakeInstanceStore = {
    getInstance: vi.fn(),
    clearPendingApprovals: vi.fn(),
    decrementPendingApproval: vi.fn(),
    changeAgentMode: vi.fn(),
    setLocalYoloMode: vi.fn(),
  };

  beforeEach(async () => {
    onUserActionRequest = () => undefined;
    onInputRequired = () => undefined;
    currentInstanceId = signal<string | null>(null);
    vi.clearAllMocks();
    fakeIpc.listUserActionRequests.mockResolvedValue({ success: true, data: [] });
    fakeIpc.listUserActionRequestsForInstance.mockResolvedValue({ success: true, data: [] });
    fakeIpc.onUserActionRequest.mockImplementation((callback: (request: unknown) => void) => {
      onUserActionRequest = callback;
      return vi.fn();
    });
    const inputListeners = new Set<typeof onInputRequired>();
    onInputRequired = (payload) => inputListeners.forEach((listener) => listener(payload));
    fakeIpc.onInputRequired.mockImplementation((callback: typeof onInputRequired) => {
      inputListeners.add(callback);
      return () => inputListeners.delete(callback);
    });
    const resolvedListeners = new Set<typeof onInputRequiredResolved>();
    onInputRequiredResolved = (payload) => resolvedListeners.forEach((listener) => listener(payload));
    fakeIpc.onInputRequiredResolved.mockImplementation((callback: typeof onInputRequiredResolved) => {
      resolvedListeners.add(callback);
      return () => resolvedListeners.delete(callback);
    });
    fakeIpc.respondToUserAction.mockResolvedValue({ success: true, data: {} });
    fakeIpc.respondToInputRequired.mockResolvedValue({ success: true, data: {} });
    fakeIpc.submitSecretCard.mockResolvedValue({ success: true, data: { reference: 'secret://github-pat' } });
    fakeIpc.declineSecretCard.mockResolvedValue({ success: true, data: { declined: true } });
    fakeIpc.sendInput.mockResolvedValue({ success: true, data: {} });
    fakeIpc.toggleYoloMode.mockResolvedValue({ success: true, data: {} });

    fakeInstanceStore.getInstance.mockReturnValue(undefined);
    fakeInstanceStore.clearPendingApprovals.mockReset();
    fakeInstanceStore.decrementPendingApproval.mockReset();
    fakeInstanceStore.changeAgentMode.mockResolvedValue(undefined);
    fakeInstanceStore.setLocalYoloMode.mockReset();

    await TestBed.configureTestingModule({
      imports: [UserActionRequestComponent],
      providers: [
        { provide: IpcFacadeService, useValue: fakeIpc },
        { provide: InstanceStore, useValue: fakeInstanceStore },
        { provide: InstanceIpcService, useValue: fakeIpc },
      ],
    }).compileComponents();

    // InstanceStore subscribes at startup, before a sidechat panel mounts.
    TestBed.inject(IpcEventBusService).inputRequired$.subscribe();
    fixture = TestBed.createComponent(UserActionRequestComponent);
    overrideInputs(fixture.componentInstance, currentInstanceId);
  });

  it('hides a user-action request when switching to a different instance', async () => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);

    onUserActionRequest(makeQuestionRequest('req-a', 'inst-a', 'Decision A'));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Decision A');

    currentInstanceId.set('inst-b');
    fixture.detectChanges();
    await settle(fixture);

    expect(fixture.nativeElement.textContent).not.toContain('Decision A');
  });

  it('renders a Codex MCP elicitation as an actionable permission prompt', async () => {
    currentInstanceId.set('inst-a');
    fakeInstanceStore.getInstance.mockReturnValue({ yoloMode: false });
    fixture.detectChanges();
    await settle(fixture);

    onInputRequired({
      instanceId: 'inst-a',
      requestId: 'codex_mcp_elicitation:mcp-1',
      prompt: 'Allow update_automation?',
      timestamp: 1_900_000_000_000,
      metadata: {
        type: 'codex_mcp_approval',
        serverName: 'orchestrator',
        toolName: 'update_automation',
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('Permission Required');
    expect(fixture.nativeElement.textContent).toContain('Allow update_automation?');
    expect(fixture.nativeElement.querySelector('.question-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.scope-select')).toBeNull();
    expect(fixture.nativeElement.querySelector('.btn-approve')?.textContent?.trim()).toBe(PERMISSION_SCOPE_WORDS.once.allow);

    const approve = fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement;
    approve.click();
    fixture.detectChanges();
    await settle(fixture);

    expect(fakeIpc.respondToInputRequired).toHaveBeenCalledWith(
      'inst-a',
      'codex_mcp_elicitation:mcp-1',
      expect.stringContaining('Permission granted'),
      undefined,
      'allow',
      'once',
      undefined,
    );
  });

  it('ignores live user-action requests for non-selected instances', async () => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);

    onUserActionRequest(makeQuestionRequest('req-b', 'inst-b', 'Decision B'));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Decision B');
  });

  it('shows a child input-required prompt after switching to that child', async () => {
    currentInstanceId.set('parent');
    fixture.detectChanges();
    await settle(fixture);

    onInputRequired({
      instanceId: 'child-1',
      requestId: 'approval-1',
      prompt: 'Allow Bash command?',
      timestamp: 1_900_000_000_000,
      metadata: {
        type: 'deferred_permission',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
      },
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Allow Bash command?');

    currentInstanceId.set('child-1');
    fixture.detectChanges();
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('Allow Bash command?');
  });

  it('recovers the exact child approval arriving before the first panel mounts', async () => {
    const payload = {
      instanceId: 'child-1', requestId: 'deferred-runtime-request', prompt: 'Allow the exact command?', timestamp: 73,
      metadata: { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 'runtime-tool', tool_input: { command: 'echo requested' } },
    };
    onInputRequired(payload);
    currentInstanceId.set('parent');
    fixture.detectChanges();
    await settle(fixture);
    expect(fixture.componentInstance.pendingRequests()).toEqual([]);

    currentInstanceId.set('child-1');
    fixture.detectChanges();
    await settle(fixture);
    expect(fixture.componentInstance.pendingRequests()).toEqual([expect.objectContaining({
      id: payload.requestId, instanceId: payload.instanceId, message: payload.prompt,
      createdAt: payload.timestamp, permissionMetadata: payload.metadata,
    })]);
    await fixture.componentInstance.onApprove(fixture.componentInstance.pendingRequests()[0]);
    expect(fakeIpc.respondToInputRequired).toHaveBeenCalledWith(
      'child-1', payload.requestId, expect.stringContaining('Permission granted'), undefined,
      'allow', 'once', { type: 'deferred_permission', tool_use_id: 'runtime-tool' },
    );
  });

  it('retains pending approvals across panel destruction and receives new ones while closed', async () => {
    currentInstanceId.set('child-1');
    fixture.detectChanges();
    await settle(fixture);
    const payload = { instanceId: 'child-1', requestId: 'first', prompt: 'First approval', timestamp: 1 };
    onInputRequired(payload);
    fixture.detectChanges();
    expect(fixture.componentInstance.pendingRequests().map(request => request.id)).toEqual(['first']);
    fixture.destroy();
    onInputRequired({ ...payload, requestId: 'second', prompt: 'Second approval' });
    onInputRequired(payload);
    fixture = TestBed.createComponent(UserActionRequestComponent);
    overrideInputs(fixture.componentInstance, currentInstanceId);
    fixture.detectChanges();
    await settle(fixture);
    expect(fixture.componentInstance.pendingRequests().map(request => request.id)).toEqual(['first', 'second']);
  });

  it('does not resurrect an approval resolved while the panel was closed', async () => {
    fixture.destroy();
    onInputRequired({ instanceId: 'child-1', requestId: 'expired', prompt: 'Expired approval', timestamp: 1 });
    onInputRequiredResolved({ instanceId: 'child-1', requestId: 'expired', reason: 'cancelled' });
    currentInstanceId.set('child-1');
    fixture = TestBed.createComponent(UserActionRequestComponent);
    overrideInputs(fixture.componentInstance, currentInstanceId);
    fixture.detectChanges();
    await settle(fixture);
    expect(fixture.componentInstance.pendingRequests()).toEqual([]);
  });

  it('recovers CLI approvals even if the orchestrator request list fails', async () => {
    fakeIpc.listUserActionRequestsForInstance.mockResolvedValue({ success: false, error: { message: 'Unavailable' } });
    onInputRequired({ instanceId: 'child-1', requestId: 'pending', prompt: 'Still waiting', timestamp: 1 });
    currentInstanceId.set('child-1');
    fixture.detectChanges();
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('Still waiting');
  });

  it('keeps a parent approval with the same request id when a child request resolves', async () => {
    currentInstanceId.set('parent');
    fixture.detectChanges();
    await settle(fixture);
    onInputRequired({ instanceId: 'parent', requestId: 'same-id', prompt: 'Parent approval', timestamp: 1 });
    onInputRequired({ instanceId: 'child', requestId: 'same-id', prompt: 'Child approval', timestamp: 2 });
    fixture.detectChanges();
    onInputRequiredResolved({ instanceId: 'child', requestId: 'same-id', reason: 'decided' });
    fixture.detectChanges();
    expect(fixture.componentInstance.pendingRequests().map(request => request.message)).toEqual(['Parent approval']);
  });

  it('does not replay a successfully answered approval after reopening', async () => {
    currentInstanceId.set('child-1');
    fixture.detectChanges();
    await settle(fixture);
    onInputRequired({ instanceId: 'child-1', requestId: 'answered', prompt: 'Allow once?', timestamp: 1,
      metadata: { type: 'deferred_permission', tool_use_id: 'exact-tool' } });
    fixture.detectChanges();
    await fixture.componentInstance.onApprove(fixture.componentInstance.pendingRequests()[0]);
    fixture.destroy();
    fixture = TestBed.createComponent(UserActionRequestComponent);
    overrideInputs(fixture.componentInstance, currentInstanceId);
    fixture.detectChanges();
    await settle(fixture);
    expect(fixture.componentInstance.pendingRequests()).toEqual([]);
  });

  it('does not reuse another session input draft when request ids coincide', async () => {
    currentInstanceId.set('parent');
    fixture.detectChanges();
    await settle(fixture);
    onInputRequired({ instanceId: 'parent', requestId: 'same-id', prompt: 'Parent input', timestamp: 1 });
    onInputRequired({ instanceId: 'child', requestId: 'same-id', prompt: 'Child input', timestamp: 2 });
    fixture.detectChanges();
    fixture.componentInstance.onInputRequiredTextChange('same-id', { target: { value: 'Parent answer' } } as unknown as Event);
    currentInstanceId.set('child');
    fixture.detectChanges();
    await settle(fixture);
    expect(fixture.componentInstance.hasInputRequiredText('same-id')).toBe(false);
    expect(fixture.componentInstance.pendingRequests().map(request => request.message)).toEqual(['Child input']);
    expect((fixture.nativeElement.querySelector('.question-input') as HTMLTextAreaElement).value).toBe('');
    fixture.componentInstance.onInputRequiredTextChange('same-id', { target: { value: 'Child answer' } } as unknown as Event);
    currentInstanceId.set('parent');
    fixture.detectChanges();
    await settle(fixture);
    expect((fixture.nativeElement.querySelector('.question-input') as HTMLTextAreaElement).value).toBe('Parent answer');
    fakeIpc.respondToInputRequired.mockResolvedValueOnce({ success: false, error: { message: 'Try again' } });
    await fixture.componentInstance.onSubmitInputRequired(fixture.componentInstance.pendingRequests()[0]);
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.question-input') as HTMLTextAreaElement).value).toBe('Parent answer');
    await fixture.componentInstance.onSubmitInputRequired(fixture.componentInstance.pendingRequests()[0]);
    expect(fakeIpc.respondToInputRequired).toHaveBeenCalledWith('parent', 'same-id', 'Parent answer', undefined);
    currentInstanceId.set('child');
    fixture.detectChanges();
    await settle(fixture);
    expect((fixture.nativeElement.querySelector('.question-input') as HTMLTextAreaElement).value).toBe('Child answer');
  });

  it('retains scope, edited input and question drafts only for their owning pending request', async () => {
    currentInstanceId.set('parent');
    fixture.detectChanges();
    await settle(fixture);
    for (const instanceId of ['parent', 'child']) {
      onInputRequired({ instanceId, requestId: 'permission', prompt: 'Allow command?', timestamp: 1,
        metadata: { type: 'deferred_permission', tool_input: { command: 'echo original' } } });
      onInputRequired({ instanceId, requestId: 'question', prompt: 'Choose and explain', timestamp: 2,
        metadata: { type: 'ask_user_question', questions: [
          { header: 'Choice', question: 'Choose', options: [{ label: 'First' }, { label: 'Second' }] },
          { header: 'Reason', question: 'Explain', options: [] },
        ] } });
    }
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const permission = () => component.pendingRequests().find(request => request.id === 'permission')!;
    component.onInputRequiredScopeChange('permission', { target: { value: 'session' } } as unknown as Event);
    component.toggleModifyPanel(permission());
    component.onModifyInputTextChange('permission', { target: { value: '{"command":"echo parent"}' } } as unknown as Event);
    asks(component).toggle('question', 0, 'First', false);
    asks(component).setText('question', 1, 'Parent explanation');
    currentInstanceId.set('child');
    fixture.detectChanges();
    await settle(fixture);
    expect(component.getInputRequiredScope(permission())).toBe('once');
    expect(component.isModifyPanelOpen('permission')).toBe(false);
    expect(asks(component).isPicked('question', 0, 'First')).toBe(false);
    expect(asks(component).text('question', 1)).toBe('');
    asks(component).toggle('question', 0, 'Second', false);
    asks(component).setText('question', 1, 'Child explanation');
    currentInstanceId.set('parent');
    fixture.detectChanges();
    await settle(fixture);
    expect(component.getInputRequiredScope(permission())).toBe('session');
    expect(component.isModifyPanelOpen('permission')).toBe(true);
    expect((fixture.nativeElement.querySelector('.modify-textarea') as HTMLTextAreaElement).value).toBe('{"command":"echo parent"}');
    expect(asks(component).isPicked('question', 0, 'First')).toBe(true);
    expect(asks(component).isPicked('question', 0, 'Second')).toBe(false);
    expect(asks(component).text('question', 1)).toBe('Parent explanation');
    expect(Array.from(fixture.nativeElement.querySelectorAll('textarea') as NodeListOf<HTMLTextAreaElement>).some(textarea => textarea.value === 'Parent explanation')).toBe(true);
    fakeIpc.respondToInputRequired.mockResolvedValueOnce({ success: false, error: { message: 'Try again' } });
    await component.onSubmitAskUserQuestion(component.pendingRequests().find(request => request.id === 'question')!);
    expect(asks(component).isPicked('question', 0, 'First')).toBe(true);
    expect(asks(component).text('question', 1)).toBe('Parent explanation');
    currentInstanceId.set('child');
    fixture.detectChanges();
    await settle(fixture);
    onInputRequiredResolved({ instanceId: 'parent', requestId: 'question', reason: 'decided' });
    fixture.detectChanges();
    expect(asks(component).text('question', 1)).toBe('Child explanation');
    onInputRequired({ instanceId: 'parent', requestId: 'question', prompt: 'Fresh question', timestamp: 3 });
    currentInstanceId.set('parent');
    fixture.detectChanges();
    await settle(fixture);
    expect(asks(component).text('question', 1)).toBe('');
    expect(asks(component).isPicked('question', 0, 'First')).toBe(false);
  });

  it('clears typed secret values when changing sessions even when request ids coincide', async () => {
    currentInstanceId.set('parent');
    fixture.detectChanges();
    await settle(fixture);
    for (const instanceId of ['parent', 'child']) {
      onInputRequired({ instanceId, requestId: 'secret', prompt: 'Supply a workspace value', timestamp: 1,
        metadata: { type: 'secret_required', name: 'example-value', label: 'Workspace value', purpose: 'Connect workspace' } });
    }
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('.secret-input') as HTMLInputElement;
    input.value = 'example-placeholder-value';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.hasSecretValue('secret')).toBe(true);
    for (const instanceId of ['child', 'parent']) {
      currentInstanceId.set(instanceId);
      fixture.detectChanges();
      await settle(fixture);
      expect((fixture.nativeElement.querySelector('.secret-input') as HTMLInputElement).value).toBe('');
      expect(fixture.componentInstance.hasSecretValue('secret')).toBe(false);
    }
  });

  it('keeps existing cards stable when unrelated instance state changes', async () => {
    const instance = signal({ yoloMode: false, status: 'busy', outputRevision: 0 });
    fakeInstanceStore.getInstance.mockImplementation(() => instance());
    currentInstanceId.set('child');
    fixture.detectChanges();
    await settle(fixture);
    onInputRequired({ instanceId: 'child', requestId: 'approval', prompt: 'Pending approval', timestamp: 1 });
    fixture.detectChanges();
    const cards = fixture.componentInstance.pendingRequests();
    instance.update(value => ({ ...value, outputRevision: 1 }));
    fixture.detectChanges();
    expect(fixture.componentInstance.pendingRequests()).toBe(cards);
  });

  it('preserves a parent orchestrator secret card when child CLI requests arrive and resolve', async () => {
    currentInstanceId.set('parent');
    fixture.detectChanges();
    await settle(fixture);
    const secret = makeSecretRequest('parent');
    onUserActionRequest(secret);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.secret-input')).not.toBeNull();
    onInputRequired({ instanceId: 'child', requestId: 'child-approval', prompt: 'Child approval', timestamp: 1 });
    fixture.detectChanges();
    expect(fixture.componentInstance.pendingRequests()).toEqual([secret]);
    onInputRequiredResolved({ instanceId: 'child', requestId: 'child-approval', reason: 'decided' });
    fixture.detectChanges();
    expect(fixture.componentInstance.pendingRequests()).toEqual([secret]);
    expect(fixture.nativeElement.querySelector('.secret-input')).not.toBeNull();
  });

  it('preserves a server-listed parent secret card when a child CLI prompt arrives', async () => {
    const secret = makeSecretRequest('parent');
    fakeIpc.listUserActionRequestsForInstance.mockResolvedValue({ success: true, data: [secret] });
    currentInstanceId.set('parent');
    fixture.detectChanges();
    await settle(fixture);
    expect(fixture.componentInstance.pendingRequests()).toEqual([secret]);
    onInputRequired({ instanceId: 'child', requestId: 'child-approval', prompt: 'Child approval', timestamp: 1 });
    fixture.detectChanges();
    expect(fixture.componentInstance.pendingRequests()).toEqual([secret]);
  });

  it('keeps a newly received orchestrator secret when an older server list finishes loading', async () => {
    let finishList!: (result: { success: boolean; data: UserActionRequest[] }) => void;
    fakeIpc.listUserActionRequestsForInstance.mockReturnValue(new Promise(resolve => { finishList = resolve; }));
    currentInstanceId.set('parent');
    fixture.detectChanges();
    const secret = makeSecretRequest('parent');
    onUserActionRequest(secret);
    fixture.detectChanges();
    finishList({ success: true, data: [] });
    await settle(fixture);
    expect(fixture.componentInstance.pendingRequests()).toEqual([secret]);
  });

  // ── Generic ACP permission cards (timeout / Cancel / stale replies) ─────

  const showAcpPermissionCard = async (requestId = 'acp_permission:7') => {
    currentInstanceId.set('inst-acp');
    fixture.detectChanges();
    await settle(fixture);
    onInputRequired({
      instanceId: 'inst-acp',
      requestId,
      prompt: 'ACP agent requests permission to continue tool execution. Tool: rm answer.txt',
      timestamp: 1_900_000_000_000,
      metadata: { type: 'acp_permission_request', transport: 'acp' },
    });
    fixture.detectChanges();
  };
  const buttonByText = (text: string): HTMLButtonElement =>
    Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
      .find((button) => button.textContent?.trim() === text)!;

  it('removes an ACP card when its request is settled without the user (timeout)', async () => {
    await showAcpPermissionCard();
    expect(fixture.nativeElement.textContent).toContain('Tool: rm answer.txt');

    onInputRequiredResolved({ instanceId: 'inst-acp', requestId: 'acp_permission:7', reason: 'timeout' });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Tool: rm answer.txt');
    expect(fakeIpc.respondToInputRequired).not.toHaveBeenCalled();
  });

  it('Cancel on an ACP card sends a keyed cancel and removes the card', async () => {
    await showAcpPermissionCard();

    buttonByText('Cancel').click();
    await settle(fixture);
    fixture.detectChanges();

    expect(fakeIpc.respondToInputRequired).toHaveBeenCalledWith('inst-acp', 'acp_permission:7', ' ', 'acp_permission:7');
    expect(fixture.nativeElement.textContent).not.toContain('Tool: rm answer.txt');
    expect(fakeInstanceStore.decrementPendingApproval).toHaveBeenCalledWith('inst-acp', 'acp_permission:7');
  });

  it('drops a card whose request already expired instead of showing an error', async () => {
    fakeIpc.respondToInputRequired.mockResolvedValue({
      success: false,
      error: { code: 'INPUT_REQUIRED_NOT_PENDING', message: 'No pending ACP permission or elicitation request is waiting for a response.' },
    });
    await showAcpPermissionCard();

    buttonByText('Cancel').click();
    await settle(fixture);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Tool: rm answer.txt');
    expect(fixture.nativeElement.textContent).not.toContain('No pending ACP permission');
    // The resolved event owns the pending count for settled requests.
    expect(fakeInstanceStore.decrementPendingApproval).not.toHaveBeenCalled();
  });

  it('Cancel on a non-ACP generic card sends no text', async () => {
    currentInstanceId.set('inst-claude');
    fixture.detectChanges();
    await settle(fixture);
    onInputRequired({
      instanceId: 'inst-claude',
      requestId: 'elicitation-1',
      prompt: '[docs] Pick a page',
      timestamp: 1_900_000_000_000,
      metadata: { type: 'mcp_elicitation', serverName: 'docs' },
    });
    fixture.detectChanges();

    buttonByText('Cancel').click();
    await settle(fixture);

    expect(fakeIpc.respondToInputRequired).not.toHaveBeenCalled();
  });

  // ── Modify-approval tests ────────────────────────────────────────────────

  it('hides "Edit input" toggle when deferred_permission has no tool_input', async () => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);

    onInputRequired({
      instanceId: 'inst-a',
      requestId: 'req-no-tool-input',
      prompt: 'Allow operation?',
      timestamp: 1_900_000_000_000,
      metadata: {
        type: 'deferred_permission',
        tool_use_id: 'toolu_x',
        // no tool_input
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    expect(fixture.nativeElement.textContent).not.toContain('Edit input');
  });

  it('shows "Edit input" toggle when deferred_permission has tool_input', async () => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);

    onInputRequired({
      instanceId: 'inst-a',
      requestId: 'req-with-tool-input',
      prompt: 'Allow Bash?',
      timestamp: 1_900_000_000_000,
      metadata: {
        type: 'deferred_permission',
        tool_use_id: 'toolu_y',
        tool_input: { command: 'echo hello' },
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('Edit input');
  });

  const showPermission = async (metadata: Record<string, unknown>) => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);
    onInputRequired({ instanceId: 'inst-a', requestId: 'permission-1', prompt: 'Permission required', timestamp: 1, metadata });
    fixture.detectChanges();
    await settle(fixture);
  };

  it('offers only a persistent rule and explains the restart for supported Claude denials', async () => {
    await showPermission({ type: 'permission_denial', tool_name: 'Bash', path: 'git status' });
    expect(fixture.nativeElement.querySelector('.scope-select')).toBeNull();
    expect(fixture.nativeElement.querySelector('.btn-approve')?.textContent?.trim()).toBe(
      'Always allow (adds a rule to ~/.claude/settings.json and restarts)',
    );
    expect(fixture.nativeElement.textContent).toContain('Allows Bash on git status in every Claude session.');
    expect(fixture.nativeElement.textContent).toContain('The session restarts');
    expect(fixture.nativeElement.querySelector('.btn-reject')?.textContent?.trim()).toBe("Don't allow");
  });

  it('rejects a Claude denial without sending a decision to cache or save', async () => {
    await showPermission({ type: 'permission_denial', tool_name: 'Edit', action: 'edit', path: '/tmp/a.ts' });
    buttonByText("Don't allow").click();
    await settle(fixture);
    expect(fakeIpc.respondToInputRequired).toHaveBeenCalledWith(
      'inst-a', 'permission-1', expect.stringContaining('Permission denied'), 'edit:/tmp/a.ts',
      undefined, undefined, expect.objectContaining({ type: 'permission_denial' }),
    );
  });

  it('shows no allow button for an unsupported Claude tool and explains how to retry', async () => {
    await showPermission({ type: 'permission_denial', tool_name: 'WebFetch', path: 'https://example.test' });
    expect(fixture.nativeElement.querySelector('.btn-approve')).toBeNull();
    expect(fixture.nativeElement.querySelector('.scope-select')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain("Harness can't add an allow rule for WebFetch");
    expect(fixture.nativeElement.textContent).toContain('switch on Auto-approve with the YOLO button at the top of this session');
    buttonByText('OK').click();
    await settle(fixture);
    expect(fakeIpc.respondToInputRequired.mock.calls[0]?.slice(4, 6)).toEqual([undefined, undefined]);
  });

  it('refuses a held command without a scope so it is not cached for an hour', async () => {
    await showPermission({ type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 'toolu_1' });
    expect(fixture.nativeElement.textContent).toContain('Also allows the same command for the next hour.');
    expect(fixture.nativeElement.querySelector('.btn-approve')?.textContent?.trim()).toBe(PERMISSION_SCOPE_WORDS.once.allow);
    buttonByText("Don't allow").click();
    await settle(fixture);
    expect(fakeIpc.respondToInputRequired).toHaveBeenCalledWith(
      'inst-a', 'permission-1', expect.stringContaining('Permission denied'), undefined,
      'deny', undefined, { type: 'deferred_permission', tool_use_id: 'toolu_1' },
    );
  });

  it('names held-command actions and persistence consequences for the selected scope', async () => {
    await showPermission({ type: 'deferred_permission', tool_name: 'Bash' });
    const select = fixture.nativeElement.querySelector('.scope-select') as HTMLSelectElement;
    const label = fixture.nativeElement.querySelector('.scope-label') as HTMLLabelElement;
    expect(label.htmlFor).toBe(select.id);
    expect(Array.from(select.options).map(option => option.text)).toEqual(['Once', 'This session', 'Always']);
    select.value = 'session';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.btn-approve')?.textContent?.trim()).toBe('Allow for this session');
    expect(fixture.nativeElement.querySelector('.btn-reject')?.textContent?.trim()).toBe('Block for this session');
    expect(fixture.nativeElement.textContent).not.toContain('next hour');
    select.value = 'always';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.btn-approve')?.textContent?.trim()).toBe('Always allow this command');
    expect(fixture.nativeElement.querySelector('.btn-reject')?.textContent?.trim()).toBe('Always block this command');
    expect(fixture.nativeElement.textContent).toContain('Saved in Harness (~/.orchestrator/permissions.json) for this exact command, in every session.');
  });

  it('shows inline error and does NOT call respondToInputRequired on invalid JSON', async () => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);

    onInputRequired({
      instanceId: 'inst-a',
      requestId: 'req-bad-json',
      prompt: 'Allow Bash?',
      timestamp: 1_900_000_000_000,
      metadata: {
        type: 'deferred_permission',
        tool_use_id: 'toolu_z',
        tool_input: { command: 'echo hi' },
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    // Open the modify panel
    const toggleBtn = fixture.nativeElement.querySelector('.modify-toggle') as HTMLButtonElement;
    toggleBtn.click();
    fixture.detectChanges();
    await settle(fixture);

    // Overwrite the textarea with bad JSON
    const textarea = fixture.nativeElement.querySelector('.modify-textarea') as HTMLTextAreaElement;
    const inputEvent = new Event('input', { bubbles: true });
    Object.defineProperty(textarea, 'value', { value: 'NOT JSON {{{', writable: true });
    textarea.dispatchEvent(inputEvent);
    fixture.detectChanges();

    // Trigger approve-with-changes
    const approveBtn = fixture.nativeElement.querySelector('.btn-modify-approve') as HTMLButtonElement;
    approveBtn.click();
    fixture.detectChanges();
    await settle(fixture);

    // respondToInputRequired must NOT have been called with 'modify'
    const calls = (fakeIpc.respondToInputRequired as ReturnType<typeof vi.fn>).mock.calls;
    const modifyCalls = calls.filter((c: unknown[]) => c[4] === 'modify');
    expect(modifyCalls).toHaveLength(0);

    // Error should be visible in the DOM
    expect(fixture.nativeElement.textContent).toContain('Invalid JSON');
  });

  it('calls respondToInputRequired with decisionAction modify and parsed updatedInput on valid edit', async () => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);

    onInputRequired({
      instanceId: 'inst-a',
      requestId: 'req-valid-json',
      prompt: 'Allow Bash?',
      timestamp: 1_900_000_000_000,
      metadata: {
        type: 'deferred_permission',
        tool_use_id: 'toolu_w',
        tool_input: { command: 'echo hello' },
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    // Open the modify panel
    const toggleBtn = fixture.nativeElement.querySelector('.modify-toggle') as HTMLButtonElement;
    toggleBtn.click();
    fixture.detectChanges();
    await settle(fixture);

    // Set the textarea to valid JSON
    const textarea = fixture.nativeElement.querySelector('.modify-textarea') as HTMLTextAreaElement;
    const newInput = { command: 'echo world' };
    const inputEvent = new Event('input', { bubbles: true });
    Object.defineProperty(textarea, 'value', { value: JSON.stringify(newInput), writable: true });
    textarea.dispatchEvent(inputEvent);
    fixture.detectChanges();

    // Trigger approve-with-changes
    const approveBtn = fixture.nativeElement.querySelector('.btn-modify-approve') as HTMLButtonElement;
    approveBtn.click();
    fixture.detectChanges();
    await settle(fixture);

    const calls = (fakeIpc.respondToInputRequired as ReturnType<typeof vi.fn>).mock.calls;
    const modifyCall = calls.find((c: unknown[]) => c[4] === 'modify');
    expect(modifyCall).toBeDefined();
    // arg[0]=instanceId, [1]=requestId, [2]=response, [3]=permissionKey, [4]=decisionAction, [5]=scope, [6]=metadata, [7]=updatedInput
    expect(modifyCall![7]).toEqual(newInput);
    expect(fakeInstanceStore.decrementPendingApproval).toHaveBeenCalledWith('inst-a', 'req-valid-json');
  });

  it('shows the backend error when allowing a deferred permission fails', async () => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);
    fakeIpc.respondToInputRequired.mockResolvedValueOnce({
      success: false,
      error: { message: 'No deferred tool use pending for instance inst-a' },
    });

    onInputRequired({
      instanceId: 'inst-a',
      requestId: 'req-allow-fails',
      prompt: 'Allow Bash?',
      timestamp: 1_900_000_000_000,
      metadata: {
        type: 'deferred_permission',
        tool_use_id: 'toolu_fail',
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    const approveBtn = fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement;
    approveBtn.click();
    fixture.detectChanges();
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('Allow Bash?');
    expect(fixture.nativeElement.textContent).toContain('No deferred tool use pending');
  });

  it('approves a deferred permission with YOLO enabled from the YOLO button', async () => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);
    fakeIpc.respondToInputRequired.mockResolvedValueOnce({
      success: true,
      data: { requestId: 'req-yolo', responded: true, resumed: true, yoloMode: true },
    });

    onInputRequired({
      instanceId: 'inst-a',
      requestId: 'req-yolo',
      prompt: 'Allow Bash?',
      timestamp: 1_900_000_000_000,
      metadata: {
        type: 'deferred_permission',
        tool_use_id: 'toolu_yolo',
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    const yoloBtn = fixture.nativeElement.querySelector('.btn-yolo') as HTMLButtonElement;
    yoloBtn.click();
    fixture.detectChanges();
    await settle(fixture);

    expect(fakeIpc.toggleYoloMode).not.toHaveBeenCalled();
    expect(fakeIpc.respondToInputRequired).toHaveBeenCalledWith(
      'inst-a',
      'req-yolo',
      'Permission granted. Please proceed with the operation.',
      undefined,
      'allow',
      'once',
      {
        type: 'deferred_permission',
        tool_use_id: 'toolu_yolo',
        enableYolo: true,
      }
    );
    expect(fakeInstanceStore.setLocalYoloMode).toHaveBeenCalledWith('inst-a', true);
    expect(fixture.nativeElement.textContent).not.toContain('Allow Bash?');
  });

  it('does not change approve/deny button behaviour for non-deferred requests', async () => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);

    // A confirm request (not input_required)
    const req: UserActionRequest = {
      id: 'req-confirm',
      instanceId: 'inst-a',
      requestType: 'confirm',
      title: 'Confirm action',
      message: 'Are you sure?',
      createdAt: 1_900_000_000_000,
    };
    fixture.componentInstance.pendingRequests.set([req]);
    fixture.detectChanges();
    await settle(fixture);

    // No "Edit input" toggle should appear
    expect(fixture.nativeElement.textContent).not.toContain('Edit input');

    // Approve fires respondToUserAction, not respondToInputRequired
    fakeIpc.respondToUserAction.mockResolvedValue({ success: true });
    const approveBtn = fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement;
    approveBtn.click();
    fixture.detectChanges();
    await settle(fixture);

    expect(fakeIpc.respondToUserAction).toHaveBeenCalledWith('req-confirm', true, undefined);
  });

  // ── AskUserQuestion clickable options ────────────────────────────────────

  it('renders clickable options for AskUserQuestion and submits selected labels to the CLI', async () => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);

    onInputRequired({
      instanceId: 'inst-a',
      requestId: 'req-auq',
      prompt: 'Which posts should I comment on?\n\nOptions:\n1. Robyn Ball',
      timestamp: 1_900_000_000_000,
      metadata: {
        type: 'ask_user_question',
        tool_use_id: 'toolu_auq',
        questions: [
          {
            header: 'Posts',
            question: 'Which posts should I comment on?',
            multiSelect: true,
            options: [
              { label: 'Robyn Ball', description: 'genuine confusion' },
              { label: 'Janet Pearce', description: 'real question' },
            ],
          },
        ],
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    // Options render as buttons
    const optionButtons = Array.from(
      fixture.nativeElement.querySelectorAll('.ask-option'),
    ) as HTMLButtonElement[];
    expect(optionButtons.length).toBe(3);
    expect(fixture.nativeElement.textContent).toContain('Robyn Ball');
    expect(fixture.nativeElement.textContent).toContain('genuine confusion');

    // Submit is disabled until a selection is made
    const submitBtn = fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.getAttribute('aria-disabled')).toBe('true');
    submitBtn.focus();
    expect(document.activeElement).toBe(submitBtn);
    submitBtn.click();
    expect(fakeIpc.respondToInputRequired).not.toHaveBeenCalled();

    // Select both options (multiSelect)
    optionButtons[0].click();
    optionButtons[1].click();
    fixture.detectChanges();
    await settle(fixture);

    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.getAttribute('aria-disabled')).toBeNull();

    submitBtn.click();
    fixture.detectChanges();
    await settle(fixture);

    // The compiled answer is sent back to the CLI via respondToInputRequired
    const calls = (fakeIpc.respondToInputRequired as ReturnType<typeof vi.fn>).mock.calls;
    const auqCall = calls.find((c: unknown[]) => c[1] === 'req-auq');
    expect(auqCall).toBeDefined();
    expect(auqCall![0]).toBe('inst-a');
    expect(auqCall![2]).toBe('Posts: Robyn Ball, Janet Pearce');
    expect(fakeInstanceStore.decrementPendingApproval).toHaveBeenCalledWith('inst-a', 'req-auq');
  });

  it('single-select AskUserQuestion replaces the prior choice', async () => {
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle(fixture);

    onInputRequired({
      instanceId: 'inst-a',
      requestId: 'req-auq-single',
      prompt: 'Which flow?',
      timestamp: 1_900_000_000_000,
      metadata: {
        type: 'ask_user_question',
        tool_use_id: 'toolu_single',
        questions: [
          {
            header: 'Flow',
            question: 'Which posting flow?',
            multiSelect: false,
            options: [{ label: 'Approve each' }, { label: 'Autonomous' }],
          },
        ],
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    const optionButtons = Array.from(
      fixture.nativeElement.querySelectorAll('.ask-option'),
    ) as HTMLButtonElement[];

    optionButtons[0].click();
    fixture.detectChanges();
    optionButtons[1].click(); // replaces the first in single-select mode
    fixture.detectChanges();
    await settle(fixture);

    const submitBtn = fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement;
    submitBtn.click();
    fixture.detectChanges();
    await settle(fixture);

    const calls = (fakeIpc.respondToInputRequired as ReturnType<typeof vi.fn>).mock.calls;
    const singleCall = calls.find((c: unknown[]) => c[1] === 'req-auq-single');
    expect(singleCall).toBeDefined();
    expect(singleCall![2]).toBe('Flow: Autonomous');
  });

  it('offers and submits an own answer alongside Claude options', async () => {
    await showPermission({ type: 'ask_user_question', questions: [{ header: 'Flow', question: 'Which?', options: [{ label: 'One' }], multiSelect: false }] });
    buttonByText('Type your own answer').click(); fixture.detectChanges();
    const text = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    text.value = 'Use another way'; text.dispatchEvent(new Event('input')); fixture.detectChanges();
    buttonByText('Submit').click(); await settle(fixture);
    expect(fakeIpc.respondToInputRequired.mock.calls[0]?.slice(0, 4)).toEqual(['inst-a', 'permission-1', 'Flow: Use another way', undefined]);
    expect(fakeIpc.respondToInputRequired.mock.calls[0]?.[8]).toEqual({ kind: 'answered', summary: 'Use another way' });
  });

  it('renders the agent options and sends the exact ACP option id', async () => {
    await showPermission({ type: 'acp_permission_request', transport: 'acp', options: [
      { optionId: 'always', name: 'Remember allow', kind: 'allow_always' },
      { optionId: 'once', name: 'Just this time', kind: 'allow_once' },
    ] });
    expect(fixture.nativeElement.textContent).toContain('Applies to later requests from this agent');
    buttonByText('Just this time').click(); await settle(fixture);
    expect(fakeIpc.respondToInputRequired).toHaveBeenCalledWith('inst-a', 'permission-1', 'once', 'permission-1');
  });

  it('shows and dismisses a quiet receipt when a pending card times out', async () => {
    await showPermission({ type: 'deferred_permission', tool_name: 'Write' });
    onInputRequiredResolved({ instanceId: 'inst-a', requestId: 'permission-1', reason: 'timeout' }); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No answer in time; nothing ran');
    buttonByText('Dismiss').click(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('No answer in time');
  });

  it('sends a held refusal note as the deny response', async () => {
    await showPermission({ type: 'deferred_permission', tool_name: 'Bash' });
    buttonByText('Tell it what to do instead').click(); fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('app-permission-deny-note input') as HTMLInputElement;
    expect(buttonByText('Send').disabled).toBe(true);
    input.value = 'use /tmp instead'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    buttonByText('Send').click(); await settle(fixture);
    expect(fakeIpc.respondToInputRequired).toHaveBeenCalledWith('inst-a', 'permission-1', 'use /tmp instead', undefined, 'deny', undefined,
      expect.objectContaining({ type: 'deferred_permission', denyNote: 'use /tmp instead' }));
  });

  it('sends a refusal-card note through ordinary input after the normal denial', async () => {
    await showPermission({ type: 'permission_denial', tool_name: 'Edit', action: 'edit', path: '/tmp/file' });
    await fixture.componentInstance.onDenyWithNote(fixture.componentInstance.pendingRequests()[0], 'never touch that file');
    expect(fakeIpc.respondToInputRequired.mock.calls[0][2]).toContain('Permission denied');
    expect(fakeIpc.sendInput).toHaveBeenCalledExactlyOnceWith('inst-a', 'never touch that file');
    expect(fakeIpc.respondToInputRequired.mock.invocationCallOrder[0]).toBeLessThan(fakeIpc.sendInput.mock.invocationCallOrder[0]);
  });

  it('does not show a receipt for a decision being answered in this window', async () => {
    await showPermission({ type: 'deferred_permission', tool_name: 'Write' });
    let finish!: (value: unknown) => void;
    fakeIpc.respondToInputRequired.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const answer = fixture.componentInstance.onApprove(fixture.componentInstance.pendingRequests()[0]);
    onInputRequiredResolved({ instanceId: 'inst-a', requestId: 'permission-1', reason: 'decided' }); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Answered somewhere else');
    finish({ success: true }); await answer;
  });

  it('closes a refusal note on Escape without sending anything', async () => {
    await showPermission({ type: 'deferred_permission' });
    buttonByText('Tell it what to do instead').click(); fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('app-permission-deny-note input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-permission-deny-note input')).toBeNull();
    expect(fakeIpc.respondToInputRequired).not.toHaveBeenCalled();
  });

  it('renders the secret card and submits on the dedicated channel, never respondToInputRequired', async () => {
    currentInstanceId.set('inst-secret');
    fixture.detectChanges();
    await settle(fixture);

    onInputRequired({
      instanceId: 'inst-secret',
      requestId: 'req-secret',
      prompt: 'Need a GitHub token to install the connector.',
      timestamp: 1,
      metadata: {
        type: 'secret_required',
        name: 'github-pat',
        label: 'GitHub personal access token',
        purpose: 'Install the workspace MCP connector',
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('Stored encrypted on this Mac');
    expect(fixture.nativeElement.textContent).toContain('Install the workspace MCP connector');

    const input = fixture.nativeElement.querySelector('.secret-input') as HTMLInputElement;
    expect(input.type).toBe('password');
    input.value = 'ghp_exampleplaceholdervalue0000000000';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const saveBtn = Array.from(
      fixture.nativeElement.querySelectorAll('.btn-approve'),
    ).find((btn) => (btn as HTMLButtonElement).textContent?.includes('Save securely')) as HTMLButtonElement;
    saveBtn.click();
    fixture.detectChanges();
    await settle(fixture);

    expect(fakeIpc.submitSecretCard).toHaveBeenCalledWith({
      instanceId: 'inst-secret',
      requestId: 'req-secret',
      name: 'github-pat',
      label: 'GitHub personal access token',
      purpose: 'Install the workspace MCP connector',
      value: 'ghp_exampleplaceholdervalue0000000000',
    });
    expect(fakeIpc.respondToInputRequired).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).not.toContain('ghp_exampleplaceholdervalue0000000000');
  });

  it('clears a rejected secret from the input and accepts a fresh retry', async () => {
    currentInstanceId.set('inst-secret-retry');
    fakeIpc.submitSecretCard.mockResolvedValueOnce({
      success: false,
      error: { message: 'Secure storage unavailable' },
    });
    fixture.detectChanges();
    await settle(fixture);

    onInputRequired({
      instanceId: 'inst-secret-retry',
      requestId: 'req-secret-retry',
      prompt: 'A value is required.',
      timestamp: 1,
      metadata: {
        type: 'secret_required',
        name: 'example-value',
        label: 'Example value',
        purpose: 'Connect this workspace',
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    const input = fixture.nativeElement.querySelector('.secret-input') as HTMLInputElement;
    const saveBtn = Array.from(
      fixture.nativeElement.querySelectorAll('.btn-approve'),
    ).find((btn) => (btn as HTMLButtonElement).textContent?.includes('Save securely')) as HTMLButtonElement;
    input.value = 'example-placeholder-value';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    saveBtn.click();
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('Secure storage unavailable');
    expect(input.value).toBe('');
    expect(saveBtn.disabled).toBe(false);
    expect(saveBtn.getAttribute('aria-disabled')).toBe('true');
    saveBtn.focus();
    expect(document.activeElement).toBe(saveBtn);
    saveBtn.click();
    expect(fakeIpc.submitSecretCard).toHaveBeenCalledTimes(1);

    input.value = 'fresh-placeholder-value';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(saveBtn.disabled).toBe(false);
    expect(saveBtn.getAttribute('aria-disabled')).toBeNull();
    saveBtn.click();
    await settle(fixture);
    expect(fakeIpc.submitSecretCard).toHaveBeenCalledTimes(2);
    expect(fixture.nativeElement.querySelector('.secret-input')).toBeNull();
  });

  it('shows a non-blocking, accessible format warning for a secret that does not match the requested kind', async () => {
    currentInstanceId.set('inst-secret-format');
    fixture.detectChanges();
    await settle(fixture);

    onInputRequired({
      instanceId: 'inst-secret-format',
      requestId: 'req-secret-format',
      prompt: 'Need a GitHub token to install the connector.',
      timestamp: 1,
      metadata: {
        type: 'secret_required',
        name: 'github-pat',
        label: 'GitHub personal access token',
        purpose: 'Install the workspace MCP connector',
        expectedFormat: 'github_pat',
      },
    });
    fixture.detectChanges();
    await settle(fixture);

    const input = fixture.nativeElement.querySelector('.secret-input') as HTMLInputElement;

    // No warning before anything is typed.
    expect(fixture.nativeElement.querySelector('.secret-card-warning')).toBeNull();

    input.value = 'not-a-github-token';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const warning = fixture.nativeElement.querySelector('.secret-card-warning') as HTMLElement;
    expect(warning).not.toBeNull();
    expect(warning.textContent).toContain('does not look like a GitHub personal access token');
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.getAttribute('aria-live')).toBe('polite');
    expect(warning.id).toBe(input.getAttribute('aria-describedby'));
    // The warning never echoes the typed value.
    expect(warning.textContent).not.toContain('not-a-github-token');

    const saveBtn = Array.from(
      fixture.nativeElement.querySelectorAll('.btn-approve'),
    ).find((btn) => (btn as HTMLButtonElement).textContent?.includes('Save securely')) as HTMLButtonElement;
    // A format mismatch never blocks submission.
    expect(saveBtn.disabled).toBe(false);

    input.value = 'ghp_exampleplaceholdervalue0000000000';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.secret-card-warning')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });

  it('offers a separate Build session only on a build-mode request and clears the card after handoff', async () => {
    currentInstanceId.set('inst-a'); fixture.detectChanges(); await settle(fixture);
    onUserActionRequest({ id: 'build-request', instanceId: 'inst-a', requestType: 'switch_mode',
      targetMode: 'build', title: 'Ready to Implement', message: 'Plan ready.', createdAt: 1 });
    onUserActionRequest({ id: 'plan-request', instanceId: 'inst-a', requestType: 'switch_mode',
      targetMode: 'plan', title: 'Plan', message: 'Plan?', createdAt: 1 });
    fixture.detectChanges();
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.btn-secondary')) as HTMLButtonElement[];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('Build in a new session');
    buttons[0].click();
    expect((fixture.componentInstance as unknown as { planHandoff: () => unknown }).planHandoff())
      .toEqual({ id: 'build-request', instanceId: 'inst-a' });
    expect(fakeInstanceStore.changeAgentMode).not.toHaveBeenCalled();
    fixture.componentInstance.onPlanHandoffStarted('build-request'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Ready to Implement');
    expect(fixture.nativeElement.textContent).toContain('Plan?');
  });
});

function overrideInputs(
  component: UserActionRequestComponent,
  instanceId: () => string | null,
): void {
  (component as unknown as { instanceId: () => string | null }).instanceId = instanceId;
}

/** The component's drafts for the session it is showing; the buttons and the message box share them. */
function asks(component: UserActionRequestComponent): AskAnswerDrafts {
  return (component as unknown as { asks: AskAnswerDrafts }).asks;
}

async function settle(fixture: ComponentFixture<UserActionRequestComponent>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
  }
}

function makeQuestionRequest(
  id: string,
  instanceId: string,
  title: string,
): UserActionRequest {
  return {
    id,
    instanceId,
    requestType: 'ask_questions',
    title,
    message: 'Please decide.',
    questions: ['Question?'],
    createdAt: 1_900_000_000_000,
  };
}

function makeSecretRequest(instanceId: string): UserActionRequest {
  return {
    id: 'orchestrator-secret', instanceId, requestType: 'secret_required',
    title: 'Workspace value required', message: 'Supply a workspace value.', createdAt: 1,
    secretRequest: { name: 'example-value', label: 'Workspace value', purpose: 'Connect the workspace' },
  };
}
