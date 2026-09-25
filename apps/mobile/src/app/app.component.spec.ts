import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { AppComponent } from './app.component';
import { AppLockService } from './core/app-lock.service';
import { ApprovalPresentationStore } from './core/approval-presentation.store';
import { GatewayClient } from './core/gateway-client.service';
import { HapticsService } from './core/haptics.service';
import { HostStore } from './core/host-store';
import { LiveActivityService } from './core/live-activity.service';
import { PushService } from './core/push.service';
import { ResumeService } from './core/resume.service';
import type { MobilePromptDto, MobileSnapshot, PairedHost } from './core/models';

const PROMPT: MobilePromptDto = { id: 'prompt-a', instanceId: 'session-a', requestId: 'request-a', kind: 'permission', toolName: 'Edit', title: 'Review edit', message: 'Update the file', createdAt: 1 };
const HOST: PairedHost = { id: 'host-a', name: 'Preview host', host: 'preview.invalid', token: 'PLACEHOLDER', port: 8899, addedAt: 0 };

function setup() {
  const prompts = signal([PROMPT]);
  const activeHost = signal(HOST);
  const dataHostId = signal(HOST.id);
  const respond = vi.fn<() => Promise<void>>();
  const navigate = vi.fn();
  const endedSession = signal(false);
  const unknownHost = signal(false);
  const hostUnavailable = signal(false);
  const push = {
    init: vi.fn(), endedSession, unknownHost, hostUnavailable,
    dismissRoutingIssue: vi.fn(() => {
      endedSession.set(false); unknownHost.set(false); hostUnavailable.set(false);
    }),
    retryNotificationRouting: vi.fn(),
    openEndedSessionHistory: vi.fn(), openEndedSessionProjects: vi.fn(),
  };
  const snapshot = signal<MobileSnapshot>({
    hostName: HOST.name, serverTime: 1, projects: [], prompts: [PROMPT],
    pause: { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 },
    instances: [{ id: 'session-a', displayName: 'Review mobile', status: 'waiting', provider: 'codex', workingDirectory: '/preview/mobile', projectName: 'Mobile', createdAt: 1, lastActivity: 1, pendingApprovalCount: 1, hasUnreadCompletion: false }],
  });
  TestBed.configureTestingModule({ providers: [
    { provide: GatewayClient, useValue: { prompts, snapshot, dataHostId, respond } },
    { provide: HostStore, useValue: { activeHost, load: vi.fn().mockResolvedValue(undefined) } },
    { provide: HapticsService, useValue: { success: vi.fn() } },
    { provide: Router, useValue: { navigate } },
    { provide: AppLockService, useValue: { locked: signal(false), init: vi.fn().mockResolvedValue(undefined) } },
    { provide: LiveActivityService, useValue: { init: vi.fn() } },
    { provide: PushService, useValue: push },
    { provide: ResumeService, useValue: { restore: vi.fn() } },
  ] });
  // Keep the real app template/store; child rendering has its own contract tests.
  TestBed.overrideComponent(AppComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
  const fixture = TestBed.createComponent(AppComponent);
  const store = TestBed.inject(ApprovalPresentationStore);
  fixture.detectChanges();
  return {
    fixture, store, prompts, activeHost, dataHostId, respond, navigate, push,
    endedSession, unknownHost, hostUnavailable,
  };
}

describe('AppComponent approval wiring', () => {
  it('offers History and Projects when a push targets an ended session', () => {
    const { fixture, push, endedSession } = setup();
    endedSession.set(true);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(fixture.nativeElement.querySelector('app-mobile-sheet')?.getAttribute('ng-reflect-label')
      ?? fixture.nativeElement.querySelector('app-mobile-sheet')?.getAttribute('label'))
      .toContain('This session has ended');
    expect(text).toContain('History');
    expect(text).toContain('Projects');
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    buttons.find((button) => button.textContent?.trim() === 'History')?.click();
    expect(push.openEndedSessionHistory).toHaveBeenCalled();
  });

  it('explains that the sending host must be paired when a push targets an unknown host', () => {
    const { fixture, unknownHost } = setup();
    unknownHost.set(true);
    fixture.detectChanges();

    const sheet = fixture.nativeElement.querySelector('app-mobile-sheet');
    expect(sheet?.getAttribute('ng-reflect-label') ?? sheet?.getAttribute('label'))
      .toContain('Host not paired');
    expect(fixture.nativeElement.textContent).toContain('pair this host');
  });

  it('offers a retry when the paired host cannot be reached', () => {
    const { fixture, push, hostUnavailable } = setup();
    hostUnavailable.set(true);
    fixture.detectChanges();

    const sheet = fixture.nativeElement.querySelector('app-mobile-sheet');
    expect(sheet?.getAttribute('ng-reflect-label') ?? sheet?.getAttribute('label'))
      .toContain('Host unavailable');
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    buttons.find((button) => button.textContent?.trim() === 'Retry')?.click();
    expect(push.retryNotificationRouting).toHaveBeenCalledOnce();
  });
  it('passes host, project and session context into every approval', () => {
    const { fixture } = setup();
    expect(fixture.debugElement.query((node) => node.name === 'app-approval-sheet').properties['context'])
      .toEqual({ host: 'Preview host', project: 'Mobile', session: 'Review mobile' });
  });

  it('binds a scoped rejection and retained draft to the sheet', async () => {
    const { fixture, store, respond } = setup();
    store.updateAnswer(0, 'Keep my answer');
    respond.mockRejectedValueOnce(new Error('Decision was rejected'));
    await store.decide({ action: 'allow', scope: 'once' });
    fixture.detectChanges();
    const sheet = fixture.debugElement.query((node) => node.name === 'app-approval-sheet');
    expect(sheet.properties['error']).toBe('Decision was rejected');
    expect(sheet.properties['draft'].answers[0]).toBe('Keep my answer');
    expect(sheet.properties['pending']).toBe(false);
  });

  it('opens the permission session and permits reopening the retained request', () => {
    const { fixture, store, navigate } = setup();
    fixture.debugElement.query((node) => node.name === 'app-approval-sheet').triggerEventHandler('open');
    fixture.detectChanges();
    expect(navigate).toHaveBeenCalledWith(['/projects', '/preview/mobile', 'sessions', 'session-a']);
    expect(fixture.nativeElement.querySelector('app-approval-sheet')).toBeNull();
    expect(store.requests()).toHaveLength(1);
    store.open();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-approval-sheet')).not.toBeNull();
  });

  it('accepts field and decision events across an equivalent snapshot of the same request', () => {
    const { fixture, store, prompts, respond } = setup();
    const sheet = fixture.debugElement.query((node) => node.name === 'app-approval-sheet');
    prompts.set([{ ...PROMPT }]);
    // The request identity is unchanged, so an object replacement is not stale.
    sheet.triggerEventHandler('answerChange', { index: 0, value: 'Same request answer' });
    sheet.triggerEventHandler('scopeChange', 'session');
    expect(store.draft()).toEqual({ scope: 'session', answers: { 0: 'Same request answer' } });
    sheet.triggerEventHandler('decision', { action: 'allow', scope: 'session' });
    expect(respond).toHaveBeenCalledExactlyOnceWith('session-a', {
      requestId: 'request-a', decisionAction: 'allow', decisionScope: 'session', response: undefined,
    });
  });

  it('allows a current picker event, Later and an external reopen without a sheet context', () => {
    const { fixture, store, prompts } = setup();
    prompts.set([PROMPT, { ...PROMPT, id: 'prompt-next', requestId: 'request-next' }]);
    fixture.detectChanges();
    fixture.debugElement.query((node) => node.name === 'app-approval-sheet')
      .triggerEventHandler('requestSelected', 'prompt-next');
    expect(store.activePrompt()?.id).toBe('prompt-next');
    fixture.detectChanges();
    fixture.debugElement.query((node) => node.name === 'app-approval-sheet').triggerEventHandler('dismiss');
    expect(store.activePrompt()).toBeNull();
    store.open();
    expect(store.activePrompt()?.id).toBe('prompt-next');
  });

  describe.each(['other host', 'other host with same prompt object', 'another request on this host'])('%s', (transition) => {
    it.each([
      ['answerChange', { index: 0, value: 'Old sheet answer' }],
      ['scopeChange', 'always'],
      ['dismiss', undefined],
      ['requestSelected', 'prompt-next'],
      ['decision', { action: 'allow', scope: 'always' }],
      ['open', undefined],
    ])('rejects stale %s before the sheet renders its new context', (eventName, payload) => {
      const { fixture, store, prompts, activeHost, dataHostId, respond, navigate } = setup();
      const oldSheet = fixture.debugElement.query((node) => node.name === 'app-approval-sheet');
      const sameHost = transition === 'another request on this host';
      const replacement = transition === 'other host with same prompt object'
        ? PROMPT
        : { ...PROMPT, requestId: sameHost ? 'replacement-request' : PROMPT.requestId };
      if (!sameHost) {
        activeHost.set({ ...HOST, id: 'host-b' });
        dataHostId.set('host-b');
      }
      prompts.set([replacement, { ...PROMPT, id: 'prompt-next', requestId: 'request-next' }]);
      // Deliberately do not tick/change-detect: the event still carries the old view.
      oldSheet.triggerEventHandler(eventName as string, payload);
      expect(store.draft()).toEqual({ scope: 'once', answers: {} });
      expect(store.activePrompt()).toBe(replacement);
      expect(store.requests()).toHaveLength(2);
      expect(respond).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });
  });
});
