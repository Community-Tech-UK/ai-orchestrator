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

import { ElectronIpcService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';
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

  const fakeIpc = {
    listUserActionRequests: vi.fn(),
    listUserActionRequestsForInstance: vi.fn(),
    onUserActionRequest: vi.fn(),
    onInputRequired: vi.fn(),
    respondToUserAction: vi.fn(),
    respondToInputRequired: vi.fn(),
    toggleYoloMode: vi.fn(),
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
    fakeIpc.onInputRequired.mockImplementation((callback: typeof onInputRequired) => {
      onInputRequired = callback;
      return vi.fn();
    });
    fakeIpc.respondToUserAction.mockResolvedValue({ success: true, data: {} });
    fakeIpc.respondToInputRequired.mockResolvedValue({ success: true, data: {} });
    fakeIpc.toggleYoloMode.mockResolvedValue({ success: true, data: {} });

    fakeInstanceStore.getInstance.mockReturnValue(undefined);
    fakeInstanceStore.clearPendingApprovals.mockReset();
    fakeInstanceStore.decrementPendingApproval.mockReset();
    fakeInstanceStore.changeAgentMode.mockResolvedValue(undefined);
    fakeInstanceStore.setLocalYoloMode.mockReset();

    await TestBed.configureTestingModule({
      imports: [UserActionRequestComponent],
      providers: [
        { provide: ElectronIpcService, useValue: fakeIpc },
        { provide: InstanceStore, useValue: fakeInstanceStore },
      ],
    }).compileComponents();

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
    expect(optionButtons.length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('Robyn Ball');
    expect(fixture.nativeElement.textContent).toContain('genuine confusion');

    // Submit is disabled until a selection is made
    const submitBtn = fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    // Select both options (multiSelect)
    optionButtons[0].click();
    optionButtons[1].click();
    fixture.detectChanges();
    await settle(fixture);

    expect(submitBtn.disabled).toBe(false);

    submitBtn.click();
    fixture.detectChanges();
    await settle(fixture);

    // The compiled answer is sent back to the CLI via respondToInputRequired
    const calls = (fakeIpc.respondToInputRequired as ReturnType<typeof vi.fn>).mock.calls;
    const auqCall = calls.find((c: unknown[]) => c[1] === 'req-auq');
    expect(auqCall).toBeDefined();
    expect(auqCall![0]).toBe('inst-a');
    expect(auqCall![2]).toBe('Posts: Robyn Ball, Janet Pearce');
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
});

function overrideInputs(
  component: UserActionRequestComponent,
  instanceId: () => string | null,
): void {
  (component as unknown as { instanceId: () => string | null }).instanceId = instanceId;
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
