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

import { IpcFacadeService } from '../../core/services/ipc';
import { PlanModeIpcService } from '../../core/services/ipc/plan-mode-ipc.service';
import { ToastService } from '../../core/services/toast.service';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceStateService } from '../../core/state/instance/instance-state.service';
import { UserActionRequestComponent } from './user-action-request.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
// The REAL template, so the dialog's `(started)` and `(closed)` bindings are under test.
const template = readFileSync(resolve(specDirectory, './user-action-request.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './user-action-request.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('user-action-request.component.html')) return Promise.resolve(template);
  if (url.endsWith('user-action-request.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('UserActionRequestComponent plan hand-off bindings (R6N4)', () => {
  let fixture: ComponentFixture<UserActionRequestComponent>;
  let onUserActionRequest: (request: unknown) => void;
  let currentInstanceId: WritableSignal<string | null>;

  const fakeIpc = {
    listUserActionRequests: vi.fn(),
    listUserActionRequestsForInstance: vi.fn(),
    onUserActionRequest: vi.fn(),
    onInputRequired: vi.fn(),
    onInputRequiredResolved: vi.fn(),
    respondToUserAction: vi.fn(),
  };
  const fakeInstanceStore = {
    getInstance: vi.fn(),
    clearPendingApprovals: vi.fn(),
    decrementPendingApproval: vi.fn(),
    changeAgentMode: vi.fn(),
  };
  const previewPlanHandoff = vi.fn();
  const startPlanHandoff = vi.fn();
  const setSelectedInstance = vi.fn();

  beforeEach(async () => {
    onUserActionRequest = () => undefined;
    currentInstanceId = signal<string | null>(null);
    vi.clearAllMocks();
    fakeIpc.listUserActionRequests.mockResolvedValue({ success: true, data: [] });
    fakeIpc.listUserActionRequestsForInstance.mockResolvedValue({ success: true, data: [] });
    fakeIpc.onUserActionRequest.mockImplementation((callback: (request: unknown) => void) => {
      onUserActionRequest = callback;
      return vi.fn();
    });
    fakeIpc.onInputRequired.mockReturnValue(vi.fn());
    fakeIpc.onInputRequiredResolved.mockReturnValue(vi.fn());
    fakeInstanceStore.getInstance.mockReturnValue(undefined);
    previewPlanHandoff.mockResolvedValue({ success: true, data: {
      planText: '1. Build the export screen.', truncated: false, source: 'assistant',
      planningContextTokens: 142_000, planTokensEstimate: 8,
      provider: 'claude', model: 'claude-sonnet-4-6', canStart: true,
    } });
    startPlanHandoff.mockResolvedValue({ success: true, data: { newInstanceId: 'build-1' } });

    await TestBed.configureTestingModule({
      imports: [UserActionRequestComponent],
      providers: [
        { provide: IpcFacadeService, useValue: fakeIpc },
        { provide: InstanceStore, useValue: fakeInstanceStore },
        { provide: PlanModeIpcService, useValue: { previewPlanHandoff, startPlanHandoff } },
        { provide: InstanceStateService, useValue: { setSelectedInstance } },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(UserActionRequestComponent);
    (fixture.componentInstance as unknown as { instanceId: () => string | null }).instanceId = currentInstanceId;
    currentInstanceId.set('inst-a');
    fixture.detectChanges();
    await settle();
    onUserActionRequest({ id: 'build-request', instanceId: 'inst-a', requestType: 'switch_mode',
      targetMode: 'build', title: 'Ready to Implement', message: 'Plan ready.', createdAt: 1 });
    onUserActionRequest({ id: 'other-request', instanceId: 'inst-a', requestType: 'switch_mode',
      targetMode: 'plan', title: 'Other card', message: 'Plan?', createdAt: 1 });
    fixture.detectChanges();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await Promise.resolve();
      fixture.detectChanges();
    }
  }

  const root = () => fixture.nativeElement as HTMLElement;
  const dialog = () => root().querySelector('app-plan-handoff-dialog');
  const dialogButton = (label: string) =>
    Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent?.includes(label))!;
  const openDialog = async () => {
    (root().querySelector('.btn-secondary') as HTMLButtonElement).click();
    await settle();
  };

  it('renders the dialog for the clicked card, with that card as the request to dismiss', async () => {
    expect(dialog()).toBeNull();
    await openDialog();
    expect(dialog(), 'the dialog renders after the card button is clicked').not.toBeNull();
    expect(previewPlanHandoff).toHaveBeenCalledWith('inst-a');
    dialogButton('Start new session').click();
    await settle();
    expect(startPlanHandoff).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'inst-a', requestId: 'build-request',
    }));
  });

  it('(started) calls onPlanHandoffStarted with the card id and clears only that card', async () => {
    const started = vi.spyOn(fixture.componentInstance, 'onPlanHandoffStarted');
    await openDialog();
    expect(root().textContent).toContain('Ready to Implement');

    dialogButton('Start new session').click();
    await settle();

    expect(started).toHaveBeenCalledExactlyOnceWith('build-request');
    expect(setSelectedInstance).toHaveBeenCalledWith('build-1');
    expect(root().textContent, 'the approved card is gone').not.toContain('Ready to Implement');
    expect(root().textContent, 'unrelated cards stay').toContain('Other card');
    expect(dialog(), 'the dialog closes after a start').toBeNull();
    expect(fakeInstanceStore.changeAgentMode).not.toHaveBeenCalled();
  });

  it('(closed) closes the dialog on Cancel and leaves the card in place', async () => {
    const started = vi.spyOn(fixture.componentInstance, 'onPlanHandoffStarted');
    await openDialog();
    dialogButton('Cancel').click();
    await settle();
    expect(dialog()).toBeNull();
    expect(started).not.toHaveBeenCalled();
    expect(startPlanHandoff).not.toHaveBeenCalled();
    expect(root().textContent).toContain('Ready to Implement');
  });

  it('a failed start keeps the dialog open and the card in place', async () => {
    startPlanHandoff.mockResolvedValue({ success: false, error: { message: 'No can do' } });
    const started = vi.spyOn(fixture.componentInstance, 'onPlanHandoffStarted');
    await openDialog();
    dialogButton('Start new session').click();
    await settle();
    expect(started).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(root().textContent).toContain('Ready to Implement');
  });
});
