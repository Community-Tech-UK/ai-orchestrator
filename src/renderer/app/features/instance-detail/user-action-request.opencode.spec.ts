import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';
import { UserActionRequestComponent } from './user-action-request.component';

const directory = dirname(fileURLToPath(import.meta.url));
await resolveComponentResources((url) => Promise.resolve(url.endsWith('user-action-request.component.html')
  ? readFileSync(resolve(directory, 'user-action-request.component.html'), 'utf8') : ''));

describe('OpenCode question forms', () => {
  beforeEach(() => { TestBed.resetTestingModule(); });

  async function question() {
    let receive: (event: unknown) => void = () => undefined;
    const ipc = { listUserActionRequestsForInstance: vi.fn(async () => ({ success: true, data: [] })),
      onUserActionRequest: () => () => undefined, onInputRequired: (handler: typeof receive) => { receive = handler; return () => undefined; },
      onInputRequiredResolved: () => () => undefined, respondToInputRequired: vi.fn(async () => ({ success: true })) };
    const store = { getInstance: () => ({ yoloMode: true, status: 'busy' }), clearPendingApprovals: vi.fn(), decrementPendingApproval: vi.fn() };
    await TestBed.configureTestingModule({ imports: [UserActionRequestComponent], providers: [
      { provide: IpcFacadeService, useValue: ipc }, { provide: InstanceStore, useValue: store },
    ] }).compileComponents();
    const fixture = TestBed.createComponent(UserActionRequestComponent);
    Object.defineProperty(fixture.componentInstance, 'instanceId', { value: signal('session') });
    fixture.detectChanges();
    await fixture.whenStable();
    receive({ instanceId: 'session', requestId: 'acp_elicitation:question', prompt: 'Which manager?', timestamp: 1,
      metadata: { type: 'acp_elicitation', transport: 'acp', questions: [{ header: 'manager', question: 'Which manager?', multiSelect: false, options: [{ label: 'Bun' }, { label: 'NPM' }] }] } });
    fixture.detectChanges();
    return { fixture, ipc };
  }

  it('shows questions with automatic permissions and returns structured selected labels', async () => {
    const { fixture, ipc } = await question();
    const options = fixture.nativeElement.querySelectorAll('.ask-option') as NodeListOf<HTMLButtonElement>;
    expect(options.length).toBe(2);
    options[0].click(); fixture.detectChanges();
    (fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(ipc.respondToInputRequired).toHaveBeenCalledWith('session', 'acp_elicitation:question', '{"manager":"Bun"}', 'acp_elicitation:question');
    fixture.destroy();
  });

  it('cancels a skipped ACP question instead of fabricating a schema answer', async () => {
    const { fixture, ipc } = await question();
    const request = fixture.componentInstance.pendingRequests()[0];
    await fixture.componentInstance.onSkipAskUserQuestion(request);
    expect(ipc.respondToInputRequired).toHaveBeenCalledWith('session', 'acp_elicitation:question', 'cancel', 'acp_elicitation:question');
    fixture.destroy();
  });
});
