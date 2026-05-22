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
  };

  beforeEach(async () => {
    onUserActionRequest = () => undefined;
    onInputRequired = () => undefined;
    currentInstanceId = signal<string | null>(null);
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
