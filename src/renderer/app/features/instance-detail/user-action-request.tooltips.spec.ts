import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { UserActionRequestComponent, type UserActionRequest } from './user-action-request.component';

const directory = dirname(fileURLToPath(import.meta.url));
await resolveComponentResources(url => Promise.resolve(
  url.endsWith('user-action-request.component.html') || url.endsWith('user-action-request.component.scss')
    ? readFileSync(resolve(directory, url), 'utf8') : '',
));

describe('permission card tooltip migration', () => {
  it('shows the complete existing auto-approval sentence and preserves the deferred approval action', async () => {
    const respondToInputRequired = vi.fn().mockResolvedValue({ success: true });
    const ipc = {
      onUserActionRequest: () => vi.fn(), onInputRequired: () => vi.fn(), onInputRequiredResolved: () => vi.fn(),
      listUserActionRequestsForInstance: vi.fn().mockResolvedValue({ success: true, data: [] }),
      respondToInputRequired,
    };
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [UserActionRequestComponent], providers: [
      { provide: IpcFacadeService, useValue: ipc },
      { provide: InstanceStore, useValue: { getInstance: () => undefined, decrementPendingApproval: vi.fn() } },
    ] }).compileComponents();
    const fixture = TestBed.createComponent(UserActionRequestComponent);
    fixture.componentRef.setInput('instanceId', 'session');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.pendingRequests.set([{
      id: 'held-permission', instanceId: 'session', requestType: 'input_required',
      title: 'Permission required', message: 'Allow this command?', createdAt: 1,
      permissionMetadata: { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 'held-tool', tool_input: { command: 'pwd' } },
    } satisfies UserActionRequest]);
    fixture.detectChanges();
    const sentence = 'Enable YOLO mode to auto-approve all permissions for this session';
    expect(fixture.nativeElement.querySelector('.btn-yolo + .scope-write-hint').textContent).toBe(sentence);
    const button = fixture.debugElement.query(By.css('.btn-yolo'));
    expect(button.injector.get(AioTooltipDirective).appTooltip()).toBe(sentence);
    const element = button.nativeElement as HTMLButtonElement;
    const original = element.matches.bind(element);
    vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':focus-visible' || original(selector));
    element.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(document.getElementById(element.getAttribute('aria-describedby')!)?.textContent).toContain(sentence);
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    element.click();
    await fixture.whenStable();
    expect(respondToInputRequired).toHaveBeenCalledWith('session', 'held-permission', expect.any(String), undefined, 'allow', 'once',
      { type: 'deferred_permission', tool_use_id: 'held-tool', enableYolo: true });
    fixture.destroy();
  });
});
