import {
  signal,
  ɵresolveComponentResources as resolveComponentResources,
  type WritableSignal,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IpcFacadeService, IpcEventBusService, InstanceIpcService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { UserActionRequestComponent, type UserActionRequest } from './user-action-request.component';
import type { OutputMessage } from '../../../../shared/types/instance.types';
import { UserInputRequestRegistry } from './user-input-request.registry';

const directory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(directory, './user-action-request.component.html'), 'utf8');
const styles = readFileSync(resolve(directory, './user-action-request.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('user-action-request.component.html')) return Promise.resolve(template);
  if (url.endsWith('user-action-request.component.scss')) return Promise.resolve(styles);
  return Promise.resolve('');
});

interface InputPayload {
  instanceId: string;
  requestId: string;
  prompt: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

describe('answering a waiting question from the message box', () => {
  let fixture: ComponentFixture<UserActionRequestComponent>;
  let instanceId: WritableSignal<string | null>;
  let status: WritableSignal<string>;
  let history: WritableSignal<OutputMessage[]>;
  let onInputRequired: (payload: InputPayload) => void;
  let onUserActionRequest: (request: unknown) => void;
  let onResolved: (payload: { instanceId: string; requestId: string; reason: string }) => void;

  const ipc = {
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
  };
  const store = {
    getInstance: vi.fn(),
    clearPendingApprovals: vi.fn(),
    decrementPendingApproval: vi.fn(),
    changeAgentMode: vi.fn(),
    setLocalYoloMode: vi.fn(),
  };

  const registry = () => TestBed.inject(UserInputRequestRegistry);
  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const receiptLines = () =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.receipt-text')).map((node) => node.textContent);

  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await Promise.resolve();
      fixture.detectChanges();
    }
  }

  async function show(requestId: string, metadata: Record<string, unknown>, prompt = 'A question', owner = 'inst-a') {
    onInputRequired({ instanceId: owner, requestId, prompt, timestamp: 1_900_000_000_000, metadata });
    fixture.detectChanges();
    await settle();
  }

  const flow = (...labels: string[]) => ({
    header: 'Flow',
    question: 'Which posting flow?',
    multiSelect: false,
    options: labels.map((label) => ({ label })),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    instanceId = signal<string | null>(null);
    status = signal('busy');
    history = signal<OutputMessage[]>([]);
    onInputRequired = () => undefined;
    onUserActionRequest = () => undefined;
    onResolved = () => undefined;
    ipc.listUserActionRequestsForInstance.mockResolvedValue({ success: true, data: [] });
    ipc.onUserActionRequest.mockImplementation((callback: typeof onUserActionRequest) => {
      onUserActionRequest = callback;
      return vi.fn();
    });
    // The event bus and this card both listen, so a delivery reaches every listener.
    const inputListeners = new Set<typeof onInputRequired>();
    onInputRequired = (payload) => inputListeners.forEach((listener) => listener(payload));
    ipc.onInputRequired.mockImplementation((callback: typeof onInputRequired) => {
      inputListeners.add(callback);
      return () => inputListeners.delete(callback);
    });
    const resolvedListeners = new Set<typeof onResolved>();
    onResolved = (payload) => resolvedListeners.forEach((listener) => listener(payload));
    ipc.onInputRequiredResolved.mockImplementation((callback: typeof onResolved) => {
      resolvedListeners.add(callback);
      return () => resolvedListeners.delete(callback);
    });
    ipc.respondToUserAction.mockResolvedValue({ success: true, data: {} });
    ipc.respondToInputRequired.mockResolvedValue({ success: true, data: {} });
    ipc.submitSecretCard.mockResolvedValue({ success: true, data: {} });
    ipc.declineSecretCard.mockResolvedValue({ success: true, data: {} });
    store.getInstance.mockImplementation(() => ({ status: status(), yoloMode: false, outputBuffer: history() }));
    store.changeAgentMode.mockResolvedValue(undefined);

    await TestBed.configureTestingModule({
      imports: [UserActionRequestComponent],
      providers: [
        { provide: IpcFacadeService, useValue: ipc },
        { provide: InstanceStore, useValue: store },
        { provide: InstanceIpcService, useValue: ipc },
      ],
    }).compileComponents();

    // InstanceStore subscribes at startup, before a card mounts.
    TestBed.inject(IpcEventBusService).inputRequired$.subscribe();
    fixture = TestBed.createComponent(UserActionRequestComponent);
    (fixture.componentInstance as unknown as { instanceId: () => string | null }).instanceId = instanceId;
    instanceId.set('inst-a');
    fixture.detectChanges();
    await settle();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('choices and typed text', () => {
    it('picks the choice whose label was typed and sends it as the answer', async () => {
      await show('req-1', { type: 'ask_user_question', questions: [flow('Approve each', 'Autonomous')] });

      expect(await registry().offer('inst-a', 'autonomous')).toBe('answered');
      await settle();

      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-a', 'req-1', 'Flow: Autonomous', undefined]);
      expect(text()).not.toContain('Which posting flow?');
      expect(store.decrementPendingApproval).toHaveBeenCalledWith('inst-a');
      expect(receiptLines()).toEqual(['You answered: Autonomous']);
    });

    it('sends any other text as the typed answer', async () => {
      await show('req-1', { type: 'ask_user_question', questions: [flow('Approve each', 'Autonomous')] });

      expect(await registry().offer('inst-a', 'Neither, ask me later')).toBe('answered');

      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-a', 'req-1', 'Flow: Neither, ask me later', undefined]);
      await settle();
      expect(receiptLines()).toEqual(['You answered: Neither, ask me later']);
    });

    it('answers an ACP question with structured JSON, keyed so a stale card cannot absorb it', async () => {
      await show('acp_elicitation:q', {
        type: 'acp_elicitation',
        transport: 'acp',
        questions: [{ header: 'manager', question: 'Which manager?', multiSelect: false, options: [{ label: 'Bun' }, { label: 'NPM' }] }],
      });

      expect(await registry().offer('inst-a', 'bun')).toBe('answered');

      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-a', 'acp_elicitation:q', '{"manager":"Bun"}', 'acp_elicitation:q']);
    });

    it('sends text to a question that has no structured form as it is typed', async () => {
      await show('acp_elicitation:free', { type: 'acp_elicitation', transport: 'acp' }, 'What is the branch name?');

      expect(await registry().offer('inst-a', 'feature/receipts')).toBe('answered');

      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-a', 'acp_elicitation:free', 'feature/receipts', 'acp_elicitation:free']);
    });

    it('sends text to an MCP question without a key, as a plain reply', async () => {
      await show('mcp-1', { type: 'mcp_elicitation', serverName: 'docs' }, '[docs] Pick a page');

      expect(await registry().offer('inst-a', 'Getting started')).toBe('answered');

      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-a', 'mcp-1', 'Getting started', undefined]);
    });

    it('finishes a card that mixes a free-text question with a choice, one answer at a time', async () => {
      await show('req-1', { type: 'ask_user_question', questions: [
        { header: 'notes', question: 'Anything else?', multiSelect: false, options: [] },
        flow('Approve each', 'Autonomous'),
      ] });

      expect(await registry().offer('inst-a', 'be kind')).toBe('partial');
      expect(await registry().offer('inst-a', 'autonomous')).toBe('answered');
      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-a', 'req-1', 'notes: be kind\nFlow: Autonomous', undefined]);
    });
  });

  describe('a card with several questions', () => {
    const manyQuestions = [
      { header: 'First', question: 'First?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
      { header: 'Second', question: 'Second?', multiSelect: false, options: [] },
    ];

    it('takes one answer at a time and only sends once every question has one', async () => {
      await show('req-1', { type: 'ask_user_question', questions: manyQuestions });

      expect(await registry().offer('inst-a', 'yes')).toBe('partial');
      await settle();
      expect(ipc.respondToInputRequired).not.toHaveBeenCalled();
      const picked = fixture.nativeElement.querySelector('.ask-option.selected') as HTMLElement;
      expect(picked.textContent).toContain('Yes');
      expect(text()).toContain('First?');

      expect(await registry().offer('inst-a', 'because')).toBe('answered');
      expect(ipc.respondToInputRequired).toHaveBeenCalledTimes(1);
      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-a', 'req-1', 'First: Yes\nSecond: because', undefined]);
    });

    it('puts text typed for a free-text question into its box', async () => {
      await show('req-1', { type: 'ask_user_question', questions: [manyQuestions[1], manyQuestions[0]] });

      expect(await registry().offer('inst-a', 'because')).toBe('partial');
      await settle();

      const box = fixture.nativeElement.querySelector('textarea.question-input') as HTMLTextAreaElement;
      expect(box.value).toBe('because');
    });

    it('lets the buttons and the message box finish the same card', async () => {
      await show('req-1', { type: 'ask_user_question', questions: manyQuestions });
      (fixture.nativeElement.querySelectorAll('.ask-option')[1] as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(await registry().offer('inst-a', 'because')).toBe('answered');

      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 4)).toEqual(['inst-a', 'req-1', 'First: No\nSecond: because', undefined]);
    });

    it('does not submit a partially drafted orchestrator card through its Submit button', async () => {
      onUserActionRequest({ id: 'uar-partial', instanceId: 'inst-a', requestType: 'ask_questions',
        title: 'Two questions', message: 'Answer both', questions: ['Name?', 'Colour?'], createdAt: 1 });
      await settle();
      expect(await registry().offer('inst-a', 'Ada')).toBe('partial');
      await fixture.componentInstance.onSubmitAnswers(fixture.componentInstance.pendingRequests()[0]);
      expect(ipc.respondToUserAction).not.toHaveBeenCalled();
      // Not natively disabled: a hard-disabled button leaves keyboard users no way to learn why.
      // It stays focusable, says it is unavailable, and gives the reason, like Submit on the choice card.
      const submit = fixture.debugElement.query(By.css('.btn-approve'));
      const button = submit.nativeElement as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(submit.injector.get(AioTooltipDirective).appTooltipDisabledReason()).toBe('Answer every question before submitting.');
      button.click();
      await settle();
      expect(ipc.respondToUserAction).not.toHaveBeenCalled();
    });

    it('answers the plain orchestrator questions the same way', async () => {
      onUserActionRequest({
        id: 'uar-1',
        instanceId: 'inst-a',
        requestType: 'ask_questions',
        title: 'Two questions',
        message: 'Please answer.',
        questions: ['Name?', 'Colour?'],
        createdAt: 1,
      } satisfies UserActionRequest);
      fixture.detectChanges();
      await settle();

      expect(await registry().offer('inst-a', 'Ada')).toBe('partial');
      expect(ipc.respondToUserAction).not.toHaveBeenCalled();
      expect(await registry().offer('inst-a', 'green')).toBe('answered');

      expect(ipc.respondToUserAction).toHaveBeenCalledWith('uar-1', true, '{"Name?":"Ada","Colour?":"green"}');
      await settle();
      expect(receiptLines()).toEqual(['You answered: Ada; green']);
    });
  });

  it('keeps partial drafts separate for two sessions using the same request id', async () => {
    const questions = [{ question: 'Name?', options: [] }, { question: 'Colour?', options: [] }];
    await show('shared-draft', { type: 'ask_user_question', questions });
    expect(await registry().offer('inst-a', 'Ada')).toBe('partial');
    await show('shared-draft', { type: 'ask_user_question', questions }, 'Questions', 'inst-b');
    instanceId.set('inst-b');
    await settle();
    expect(await registry().offer('inst-b', 'Bob')).toBe('partial');
    instanceId.set('inst-a');
    await settle();
    expect(await registry().offer('inst-a', 'red')).toBe('answered');
    expect(ipc.respondToInputRequired.mock.calls.at(-1)?.slice(0, 3)).toEqual(['inst-a', 'shared-draft', 'Name?: Ada\nColour?: red']);
  });

  it('does not resurrect a question from a pending-list snapshot taken before it closed', async () => {
    const request: UserActionRequest = { id: 'uar-load-race', instanceId: 'inst-a', requestType: 'select_option',
      title: 'Pick one', message: 'Which?', options: [{ id: 'a', label: 'Alpha' }], createdAt: 1 };
    onUserActionRequest(request);
    await settle();
    let release!: (value: unknown) => void;
    ipc.listUserActionRequestsForInstance.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const loading = (fixture.componentInstance as unknown as { loadPendingRequests(): Promise<void> }).loadPendingRequests();
    onResolved({ instanceId: 'inst-a', requestId: request.id, reason: 'cancelled' });
    release({ success: true, data: [request] });
    await loading;
    await settle();
    expect(fixture.componentInstance.pendingRequests()).toEqual([]);
    expect(registry().hasWaitingQuestion('inst-a')).toBe(false);
  });

  describe('orchestrator choice cards', () => {
    const choiceCard = (): UserActionRequest => ({
      id: 'uar-2',
      instanceId: 'inst-a',
      requestType: 'select_option',
      title: 'Pick one',
      message: 'Which?',
      options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
      createdAt: 1,
    });

    it('sends the id of the choice whose label was typed', async () => {
      onUserActionRequest(choiceCard());
      fixture.detectChanges();
      await settle();

      expect(await registry().offer('inst-a', ' beta ')).toBe('answered');

      expect(ipc.respondToUserAction).toHaveBeenCalledWith('uar-2', true, 'b');
      await settle();
      expect(receiptLines()).toEqual(['You chose: Beta']);
    });

    it('sends other text as the typed answer', async () => {
      onUserActionRequest(choiceCard());
      fixture.detectChanges();
      await settle();

      expect(await registry().offer('inst-a', 'Neither, thanks')).toBe('answered');

      expect(ipc.respondToUserAction).toHaveBeenCalledWith('uar-2', true, 'Neither, thanks');
    });
  });

  describe('approvals are never answered by typing', () => {
    it.each([
      ['a held Claude command', { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 't1' }],
      ['a Claude denial', { type: 'permission_denial', tool_name: 'Bash', path: 'git status' }],
      ['a Codex MCP approval', { type: 'codex_mcp_approval', serverName: 'orchestrator', toolName: 'update_automation' }],
      ['an ACP permission request', { type: 'acp_permission_request', transport: 'acp', toolName: 'rm answer.txt' }],
    ])('refuses %s', async (_name, metadata) => {
      await show('perm-1', metadata, 'Allow it?');

      expect(await registry().offer('inst-a', 'yes, allow it')).toBe('not-applicable');
      await settle();

      expect(ipc.respondToInputRequired).not.toHaveBeenCalled();
      expect(text()).toContain('Allow it?');
    });

    it('refuses an orchestrator tool-permission picker, even when the text names an option', async () => {
      onUserActionRequest({
        id: 'uar-perm',
        instanceId: 'inst-a',
        requestType: 'select_option',
        title: 'Tool Permission Required',
        message: 'Allow running local tool "read_file"?',
        options: [
          { id: 'allow_once', label: 'Allow once (Recommended)' },
          { id: 'deny_once', label: 'Deny once' },
        ],
        context: { suppressInjectResponse: true, permission: { scope: 'tool_use', resource: 'read_file' } },
        createdAt: 1,
      } satisfies UserActionRequest);
      fixture.detectChanges();
      await settle();

      expect(await registry().offer('inst-a', 'Allow once (Recommended)')).toBe('not-applicable');
      expect(ipc.respondToUserAction).not.toHaveBeenCalled();
    });

    it('refuses orchestrator confirmations and secret requests', async () => {
      onUserActionRequest({
        id: 'uar-confirm',
        instanceId: 'inst-a',
        requestType: 'confirm',
        title: 'Confirm',
        message: 'Are you sure?',
        createdAt: 1,
      } satisfies UserActionRequest);
      await show('secret-1', { type: 'secret_required', name: 'token', label: 'Token', purpose: 'Install' });

      expect(await registry().offer('inst-a', 'yes')).toBe('not-applicable');
      expect(ipc.respondToUserAction).not.toHaveBeenCalled();
      expect(ipc.respondToInputRequired).not.toHaveBeenCalled();
      expect(ipc.submitSecretCard).not.toHaveBeenCalled();
    });

    it('does not let a digit typed anywhere pick an option on a permission picker', async () => {
      onUserActionRequest({
        id: 'uar-perm',
        instanceId: 'inst-a',
        requestType: 'select_option',
        title: 'Tool Permission Required',
        message: 'Allow it?',
        options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'deny_once', label: 'Deny once' }],
        context: { permission: { resource: 'read_file' } },
        createdAt: 1,
      } satisfies UserActionRequest);
      fixture.detectChanges();
      await settle();

      const composer = document.createElement('textarea');
      document.body.appendChild(composer);
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
      composer.remove();
      await settle();

      expect(ipc.respondToUserAction).not.toHaveBeenCalled();
    });

    it('still lets the number keys pick an option when nothing is being typed into', async () => {
      onUserActionRequest({
        id: 'uar-2',
        instanceId: 'inst-a',
        requestType: 'select_option',
        title: 'Pick one',
        message: 'Which?',
        options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
        createdAt: 1,
      } satisfies UserActionRequest);
      fixture.detectChanges();
      await settle();

      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
      await settle();

      expect(ipc.respondToUserAction).toHaveBeenCalledWith('uar-2', true, 'b');
    });

    it('leaves the approval card working after refusing the typed text', async () => {
      await show('perm-1', { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 't1' }, 'Allow Bash?');
      await registry().offer('inst-a', 'yes');

      (fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement).click();
      await settle();

      expect(ipc.respondToInputRequired).toHaveBeenCalledWith(
        'inst-a', 'perm-1', expect.stringContaining('Permission granted'), undefined, 'allow', 'once',
        { type: 'deferred_permission', tool_use_id: 't1' },
      );
      expect(receiptLines()).toEqual(['You allowed once: Bash']);
    });
  });

  describe('a card that closes without the person', () => {
    it('leaves a receipt saying how long nobody answered', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
      await show('acp_permission:7', { type: 'acp_permission_request', transport: 'acp', toolName: 'rm answer.txt' }, 'Allow rm?');
      vi.setSystemTime(new Date('2026-10-20T10:05:00Z'));

      onResolved({ instanceId: 'inst-a', requestId: 'acp_permission:7', reason: 'timeout' });
      fixture.detectChanges();

      expect(receiptLines()).toEqual(['No answer in 5 minutes; nothing ran']);
      expect(text()).not.toContain('Allow rm?');
    });

    it('stops answering a question once it has timed out', async () => {
      await show('acp_elicitation:q', { type: 'acp_elicitation', transport: 'acp' }, 'Which one?');
      onResolved({ instanceId: 'inst-a', requestId: 'acp_elicitation:q', reason: 'timeout' });
      fixture.detectChanges();

      expect(await registry().offer('inst-a', 'late reply')).toBe('not-applicable');
      expect(ipc.respondToInputRequired).not.toHaveBeenCalled();
    });

    it.each([
      ['decided', 'Answered elsewhere'],
      ['exited', 'Cancelled when the session closed'],
      ['cancelled', 'Cancelled when the session was stopped'],
      ['auto_approved', 'Allowed automatically'],
    ])('says %s plainly', async (reason, line) => {
      await show('perm-1', { type: 'acp_permission_request', transport: 'acp' }, 'Allow it?');
      onResolved({ instanceId: 'inst-a', requestId: 'perm-1', reason });
      fixture.detectChanges();

      expect(receiptLines()).toEqual([line]);
    });

    it('leaves a receipt when the session closes under a waiting card', async () => {
      await show('req-1', { type: 'ask_user_question', questions: [flow('Approve each', 'Autonomous')] });

      status.set('terminated');
      fixture.detectChanges();
      await settle();

      expect(text()).not.toContain('Which posting flow?');
      expect(receiptLines()).toEqual(['Cancelled when the session closed']);
      expect(await registry().offer('inst-a', 'autonomous')).toBe('not-applicable');
    });

    it('says the session was stopped when it is being interrupted, not closed', async () => {
      await show('perm-1', { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 't1' }, 'Allow Bash?');

      status.set('interrupting');
      fixture.detectChanges();
      await settle();

      expect(receiptLines()).toEqual(['Cancelled when the session was stopped']);
    });

    it('does not call it "answered elsewhere" when the reply was this window\'s own', async () => {
      await show('acp_elicitation:q', { type: 'acp_elicitation', transport: 'acp' }, 'Which one?');
      ipc.respondToInputRequired.mockImplementationOnce(async () => {
        // A remote worker reports "decided" before the reply returns.
        onResolved({ instanceId: 'inst-a', requestId: 'acp_elicitation:q', reason: 'decided' });
        return { success: true, data: {} };
      });

      expect(await registry().offer('inst-a', 'Bun')).toBe('answered');
      await settle();

      expect(receiptLines()).toEqual(['You answered: Bun']);
    });

    it('uses the durable outcome when it arrives before the local acknowledgement', async () => {
      await show('req-durable', { type: 'ask_user_question', questions: [flow('Bun', 'NPM')] });
      ipc.respondToInputRequired.mockImplementationOnce(async () => {
        history.set([{ id: 'receipt-output', type: 'system', content: 'You answered: Bun', timestamp: 2,
          metadata: { presentationKind: 'request-receipt', audience: 'attention', requestId: 'req-durable',
            requestedAt: 1_900_000_000_000, outcome: 'answered' } }]);
        onResolved({ instanceId: 'inst-a', requestId: 'req-durable', reason: 'decided' });
        fixture.detectChanges();
        return { success: true };
      });
      expect(await registry().offer('inst-a', 'Bun')).toBe('answered');
      await settle();
      expect(receiptLines()).toEqual([]);
      expect(history().map(row => row.content)).toEqual(['You answered: Bun']);
      expect(store.decrementPendingApproval).not.toHaveBeenCalled();
      expect(ipc.respondToInputRequired.mock.calls.at(-1)?.[8]).toEqual({ kind: 'answered', summary: 'Bun' });
    });

    it('keeps a timeout outcome when a late IPC success arrives', async () => {
      await show('req-timeout', { type: 'ask_user_question', questions: [flow('Bun', 'NPM')] });
      ipc.respondToInputRequired.mockImplementationOnce(async () => {
        onResolved({ instanceId: 'inst-a', requestId: 'req-timeout', reason: 'timeout' });
        return { success: true };
      });
      expect(await registry().offer('inst-a', 'Bun')).toBe('not-applicable');
      await settle();
      expect(receiptLines()).toEqual(['No answer in time; the question was dropped']);
    });

    it('keeps only the receipts for the session being shown', async () => {
      await show('perm-b', { type: 'acp_permission_request', transport: 'acp', toolName: 'ls' }, 'Allow ls?', 'inst-b');
      onResolved({ instanceId: 'inst-b', requestId: 'perm-b', reason: 'decided' });
      fixture.detectChanges();

      expect(receiptLines()).toEqual([]);
      instanceId.set('inst-b');
      fixture.detectChanges();
      await settle();
      expect(receiptLines()).toEqual(['Answered elsewhere']);
    });
  });

  describe('when delivering the answer fails', () => {
    it('keeps the card, shows why, and reports that nothing was sent', async () => {
      ipc.respondToInputRequired.mockResolvedValueOnce({ success: false, error: { message: 'Session is restarting' } });
      await show('req-1', { type: 'ask_user_question', questions: [flow('Approve each', 'Autonomous')] });

      expect(await registry().offer('inst-a', 'autonomous')).toBe('failed');
      await settle();

      expect(text()).toContain('Which posting flow?');
      expect(text()).toContain('Session is restarting');
      expect(receiptLines()).toEqual([]);
    });

    it('drops a stale orchestrator question without claiming an answer succeeded', async () => {
      onUserActionRequest({ id: 'uar-stale', instanceId: 'inst-a', requestType: 'select_option',
        title: 'Pick one', message: 'Which?', options: [{ id: 'a', label: 'Alpha' }], createdAt: 1 });
      await settle();
      ipc.respondToUserAction.mockResolvedValueOnce({ success: false, error: { code: 'USER_ACTION_NOT_PENDING', message: 'Already closed' } });
      expect(await registry().offer('inst-a', 'Alpha')).toBe('not-applicable');
      await settle();
      expect(fixture.componentInstance.pendingRequests()).toEqual([]);
      expect(receiptLines()).toEqual([]);
    });

    it('does not close this session when another session resolves the same request id', async () => {
      await show('shared', { type: 'ask_user_question', questions: [flow('Yes', 'No')] });
      onResolved({ instanceId: 'inst-b', requestId: 'shared', reason: 'timeout' });
      await settle();
      expect(fixture.componentInstance.pendingRequests().map(request => request.id)).toEqual(['shared']);
      expect(receiptLines()).toEqual([]);
    });

    it('can be retried after a failure', async () => {
      ipc.respondToInputRequired.mockResolvedValueOnce({ success: false, error: { message: 'Session is restarting' } });
      await show('req-1', { type: 'ask_user_question', questions: [flow('Approve each', 'Autonomous')] });

      expect(await registry().offer('inst-a', 'autonomous')).toBe('failed');
      expect(await registry().offer('inst-a', 'autonomous')).toBe('answered');
      expect(ipc.respondToInputRequired).toHaveBeenCalledTimes(2);
    });

    it('treats a thrown error as a failure too, with a plain message', async () => {
      ipc.respondToInputRequired.mockRejectedValueOnce(new Error('socket closed'));
      await show('mcp-1', { type: 'mcp_elicitation', serverName: 'docs' }, '[docs] Pick a page');

      expect(await registry().offer('inst-a', 'Getting started')).toBe('failed');
      await settle();

      expect(text()).toContain('socket closed');
    });

    it('lets the text go through as a normal message when the question had already closed', async () => {
      ipc.respondToInputRequired.mockResolvedValueOnce({
        success: false,
        error: { code: 'INPUT_REQUIRED_NOT_PENDING', message: 'No pending ACP permission or elicitation request is waiting for a response.' },
      });
      await show('acp_elicitation:q', { type: 'acp_elicitation', transport: 'acp' }, 'Which one?');

      expect(await registry().offer('inst-a', 'Bun')).toBe('not-applicable');
      await settle();

      expect(text()).not.toContain('Which one?');
      expect(text()).not.toContain('No pending ACP');
    });

    it('does not send a second copy while the card\'s own Submit button is still sending', async () => {
      let finish: (value: unknown) => void = () => undefined;
      ipc.respondToInputRequired.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      await show('req-1', { type: 'ask_user_question', questions: [flow('Approve each', 'Autonomous')] });
      (fixture.nativeElement.querySelector('.ask-option') as HTMLButtonElement).click();
      fixture.detectChanges();
      (fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement).click();
      await Promise.resolve();

      expect(await registry().offer('inst-a', 'Autonomous')).toBe('busy');
      expect(ipc.respondToInputRequired).toHaveBeenCalledTimes(1);

      finish({ success: true, data: {} });
      await settle();
      expect(receiptLines()).toEqual(['You answered: Approve each']);
    });

    it('refuses a second reply while the first is still on its way', async () => {
      let finish: (value: unknown) => void = () => undefined;
      ipc.respondToInputRequired.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      await show('mcp-1', { type: 'mcp_elicitation', serverName: 'docs' }, '[docs] Pick a page');

      const first = registry().offer('inst-a', 'Getting started');
      expect(await registry().offer('inst-a', 'Getting started')).toBe('busy');
      finish({ success: true, data: {} });
      expect(await first).toBe('answered');
      expect(ipc.respondToInputRequired).toHaveBeenCalledTimes(1);
    });
  });

  describe('receipts for what the person did with the buttons', () => {
    it('says what was allowed and for how long', async () => {
      await show('perm-1', { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 't1' }, 'Allow Bash?');
      const scope = fixture.nativeElement.querySelector('.scope-select') as HTMLSelectElement;
      scope.value = 'session';
      scope.dispatchEvent(new Event('change'));
      fixture.detectChanges();

      (fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement).click();
      await settle();

      expect(receiptLines()).toEqual(['You allowed for this session: Bash']);
    });

    it('says no when the person said no', async () => {
      await show('perm-1', { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 't1' }, 'Allow Bash?');

      (fixture.nativeElement.querySelector('.btn-reject') as HTMLButtonElement).click();
      await settle();

      expect(receiptLines()).toEqual(['You said no: Bash']);
    });

    it('does not call acknowledging a notice "saying no"', async () => {
      await show('perm-1', { type: 'permission_denial', tool_name: 'WebFetch', path: 'https://example.test' }, 'WebFetch was blocked');

      (fixture.nativeElement.querySelector('.btn-reject') as HTMLButtonElement).click();
      await settle();

      expect(receiptLines()).toEqual(['You dismissed: WebFetch']);
    });

    it('says when a question was skipped', async () => {
      await show('req-1', { type: 'ask_user_question', questions: [flow('Approve each', 'Autonomous')] });

      await fixture.componentInstance.onSkipAskUserQuestion(fixture.componentInstance.pendingRequests()[0]);
      await settle();

      expect(receiptLines()).toEqual(['You skipped the question']);
    });

    it('leaves no receipt when the reply failed', async () => {
      ipc.respondToInputRequired.mockResolvedValueOnce({ success: false, error: { message: 'nope' } });
      await show('perm-1', { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 't1' }, 'Allow Bash?');

      (fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement).click();
      await settle();

      expect(receiptLines()).toEqual([]);
    });

    it('keeps a permission card available after a failed persistent-rule write', async () => {
      ipc.respondToInputRequired.mockResolvedValueOnce({ success: false, error: {
        code: 'PERMISSION_GRANT_FAILED', message: 'The permission rule could not be saved. Try again.',
      } });
      await show('grant-failed', { type: 'permission_denial', tool_name: 'Edit' }, 'Allow Edit?');
      (fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement).click();
      await settle();
      expect(text()).toContain('Allow Edit?');
      expect(text()).toContain('The permission rule could not be saved. Try again.');
      expect(receiptLines()).toEqual([]);
      (fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement).click();
      await settle();
      expect(receiptLines()).toEqual(['You always allowed: Edit']);
    });

    it('says a secret was saved or declined, without ever showing the value', async () => {
      await show('secret-1', { type: 'secret_required', name: 'github-pat', label: 'GitHub personal access token', purpose: 'Install' });
      const input = fixture.nativeElement.querySelector('.secret-input') as HTMLInputElement;
      input.value = 'SECRET_VALUE_PLACEHOLDER';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      (fixture.nativeElement.querySelectorAll('.btn-approve')[0] as HTMLButtonElement).click();
      await settle();

      expect(receiptLines()).toEqual(['You saved: GitHub personal access token']);
      expect(text()).not.toContain('SECRET_VALUE_PLACEHOLDER');

      await show('secret-2', { type: 'secret_required', name: 'other', label: 'Other token', purpose: 'Install' });
      (fixture.nativeElement.querySelector('.btn-reject') as HTMLButtonElement).click();
      await settle();

      expect(receiptLines()).toEqual(['You said no: Other token', 'You saved: GitHub personal access token']);
    });

    it('can be dismissed', async () => {
      await show('perm-1', { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 't1' }, 'Allow Bash?');
      (fixture.nativeElement.querySelector('.btn-reject') as HTMLButtonElement).click();
      await settle();

      (fixture.nativeElement.querySelector('.receipt-dismiss') as HTMLButtonElement).click();
      await settle();

      expect(receiptLines()).toEqual([]);
    });
  });

  it('stops offering questions to the message box when the card goes away', async () => {
    await show('req-1', { type: 'ask_user_question', questions: [flow('Approve each', 'Autonomous')] });
    fixture.destroy();

    expect(await registry().offer('inst-a', 'autonomous')).toBe('not-applicable');
  });
});
