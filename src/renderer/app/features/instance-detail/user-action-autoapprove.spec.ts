import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';
import { UserActionRequestComponent } from './user-action-request.component';

const directory = dirname(fileURLToPath(import.meta.url));
await resolveComponentResources(url => Promise.resolve(url.endsWith('user-action-request.component.html')
  ? readFileSync(resolve(directory, 'user-action-request.component.html'), 'utf8') : ''));

afterEach(() => TestBed.resetTestingModule());
it('explains Auto-approve beside the button and keeps its deferred approval operation', async () => {
  const respondToInputRequired = vi.fn().mockResolvedValue({ success: true, data: { yoloMode: true } });
  const setLocalYoloMode = vi.fn();
  await TestBed.configureTestingModule({ imports: [UserActionRequestComponent], providers: [
    { provide: IpcFacadeService, useValue: {
      listUserActionRequestsForInstance: vi.fn().mockResolvedValue({ success: true, data: [] }),
      onUserActionRequest: () => vi.fn(), onInputRequired: () => vi.fn(), onInputRequiredResolved: () => vi.fn(),
      respondToInputRequired,
    } },
    { provide: InstanceStore, useValue: {
      getInstance: () => ({ status: 'waiting_for_permission', yoloMode: false }),
      setLocalYoloMode, clearPendingApprovals: vi.fn(),
    } },
  ] }).compileComponents();
  const fixture = TestBed.createComponent(UserActionRequestComponent);
  fixture.componentRef.setInput('instanceId', 'session');
  fixture.detectChanges(); await fixture.whenStable();
  fixture.componentInstance.pendingRequests.set([{
    id: 'permission', instanceId: 'session', requestType: 'input_required', title: 'Permission', message: 'Allow tool?', createdAt: 1,
    permissionMetadata: { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 'tool' },
  }]);
  fixture.detectChanges();
  const button = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')]
    .find(item => item.textContent?.trim() === 'Auto-approve');
  expect(button).toBeDefined();
  expect(button!.parentElement?.textContent).toContain('Approves all permissions for this session without asking.');
  expect(button!.hasAttribute('title')).toBe(false);
  expect(fixture.nativeElement.textContent).not.toContain('YOLO');
  button!.click(); await fixture.whenStable();
  expect(respondToInputRequired).toHaveBeenCalledWith('session', 'permission', expect.any(String), undefined,
    'allow', 'once', { type: 'deferred_permission', tool_use_id: 'tool', enableYolo: true });
  expect(setLocalYoloMode).toHaveBeenCalledWith('session', true);
});
