import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../core/state/instance';
import { RunFailureStateService, SAFE_CONTINUATION } from './run-failure-state.service';
import { RunFailureNoticeComponent } from './run-failure-notice.component';
import { presentError } from '../../../../shared/present-error';
import { UserInputRequestRegistry } from './user-input-request.registry';
import type { InstanceWaitReason } from '../../../../shared/types/instance-wait-reason.types';

describe('RunFailureNoticeComponent', () => {
  afterEach(() => TestBed.resetTestingModule());
  async function mount(sendInput = vi.fn().mockResolvedValue(undefined), instance = { status: 'idle' } as { status: string; activeTurnId?: string; waitReason?: InstanceWaitReason }) {
    const notice = signal({
      id: 'failure', presentation: { ...presentError('provider-crash', { provider: 'codex' }), rawDetail: 'RAW_DIAGNOSTIC' },
    });
    await TestBed.configureTestingModule({ imports: [RunFailureNoticeComponent], providers: [
      { provide: InstanceStore, useValue: { getInstance: () => instance, sendInput } },
      { provide: RunFailureStateService, useValue: { forInstance: () => notice() } },
    ] }).compileComponents();
    const fixture = TestBed.createComponent(RunFailureNoticeComponent);
    fixture.componentRef.setInput('instanceId', 'session');
    fixture.detectChanges();
    return { fixture, sendInput, notice, questions: TestBed.inject(UserInputRequestRegistry) };
  }

  it('keeps diagnostic text in a closed Details disclosure', async () => {
    const { fixture } = await mount();
    const details = fixture.nativeElement.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('RAW_DIAGNOSTIC');
    expect(fixture.nativeElement.querySelector('strong').textContent).not.toContain('RAW_DIAGNOSTIC');
  });

  it('sends the continuation once while delivery is pending, then makes the control usable again', async () => {
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    const { fixture, sendInput } = await mount(vi.fn().mockReturnValue(pending));
    const button = [...fixture.nativeElement.querySelectorAll('button')]
      .find((element: unknown) => (element as HTMLElement).textContent?.includes('Try again')) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    button.click();
    expect(sendInput).toHaveBeenCalledOnce();
    expect(sendInput).toHaveBeenCalledWith('session', SAFE_CONTINUATION);
    settle();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
  });

  it('cannot send a retry over a question in a later active turn', async () => {
    const { fixture, sendInput } = await mount(vi.fn(), { status: 'waiting_for_input', activeTurnId: 'new-turn' });
    const button = [...fixture.nativeElement.querySelectorAll('button')]
      .find((element: unknown) => (element as HTMLElement).textContent?.includes('Try again')) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('cannot send a retry over a registered question before its status update arrives', async () => {
    const { fixture, questions, sendInput } = await mount();
    questions.replace('card', [{ requestId: 'q', instanceId: 'session', createdAt: 1, answer: async () => 'answered' }]);
    fixture.detectChanges();
    const button = [...fixture.nativeElement.querySelectorAll('button')]
      .find((element: unknown) => (element as HTMLElement).textContent?.includes('Try again')) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('explains a waiting question beside a focusable retry control', async () => {
    const { fixture, questions, sendInput } = await mount();
    questions.replace('card', [{ requestId: 'q', instanceId: 'session', createdAt: 1, answer: async () => 'answered' }]);
    fixture.detectChanges();
    const button = [...fixture.nativeElement.querySelectorAll('button')]
      .find((element: unknown) => (element as HTMLElement).textContent?.includes('Try again')) as HTMLButtonElement;
    expect(fixture.nativeElement.textContent).toContain('Answer the waiting question before trying again.');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const reason = fixture.nativeElement.ownerDocument.getElementById(button.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toContain('Answer the waiting question');
    button.click();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('explains a lasting provider wait without allowing a continuation', async () => {
    const { fixture, sendInput } = await mount(vi.fn(), {
      status: 'idle', waitReason: { kind: 'provider-slot', provider: 'codex', startedAt: 1 },
    });
    expect(fixture.nativeElement.textContent).toContain('This session is waiting. Try again when it is ready.');
    const button = [...fixture.nativeElement.querySelectorAll('button')]
      .find((element: unknown) => (element as HTMLElement).textContent?.includes('Try again')) as HTMLButtonElement;
    button.click();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it.each([
    ['busy', 'Wait for the current turn to finish'],
    ['running', 'Wait for the current turn to finish'],
    ['initializing', 'Wait for this session to be ready'],
    ['respawning', 'Wait for this session to be ready'],
    ['waking', 'Wait for this session to be ready'],
    ['waiting_for_permission', 'Respond to the approval request'],
    ['terminated', 'This session has ended'],
  ])('explains %s without sending over that state', async (status, reason) => {
    const { fixture, sendInput } = await mount(vi.fn(), { status });
    const button = [...fixture.nativeElement.querySelectorAll('button')]
      .find((element: unknown) => (element as HTMLElement).textContent?.includes('Try again')) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(fixture.nativeElement.textContent).toContain(reason);
    button.click();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('enables safe continuation after the waiting question is answered', async () => {
    const { fixture, questions, sendInput } = await mount();
    questions.replace('card', [{ requestId: 'q', instanceId: 'session', createdAt: 1, answer: async () => 'answered' }]);
    fixture.detectChanges();
    questions.replace('card', []);
    fixture.detectChanges();
    const button = [...fixture.nativeElement.querySelectorAll('button')]
      .find((element: unknown) => (element as HTMLElement).textContent?.includes('Try again')) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    button.click();
    await fixture.whenStable();
    expect(sendInput).toHaveBeenCalledWith('session', SAFE_CONTINUATION);
  });

  it('keeps a later retry disabled until its own acknowledgement arrives', async () => {
    const acknowledgements: (() => void)[] = [];
    const { fixture, notice, sendInput } = await mount(vi.fn(() => new Promise<void>(resolve => { acknowledgements.push(resolve); })));
    const retry = () => [...fixture.nativeElement.querySelectorAll('button')]
      .find((element: unknown) => /Try again|Continuing/.test((element as HTMLElement).textContent ?? '')) as HTMLButtonElement;
    retry().click();
    notice.set({ ...notice(), id: 'later-failure' });
    fixture.detectChanges();
    retry().click();
    fixture.detectChanges();
    expect(sendInput).toHaveBeenCalledTimes(2);
    acknowledgements[0]();
    await Promise.resolve();
    fixture.detectChanges();
    expect(retry().disabled).toBe(true);
    acknowledgements[1]();
    await fixture.whenStable();
  });
});
