import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../core/state/instance';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { InterruptedContinuationComponent } from './interrupted-continuation.component';
import { SAFE_CONTINUATION } from '../../../../shared/turn-continuation';
import { UserInputRequestRegistry } from './user-input-request.registry';

describe('InterruptedContinuationComponent', () => {
  afterEach(() => TestBed.resetTestingModule());
  async function mount() {
    const instance = signal<{ status: string; lastTurnOutcome: string; activeTurnId?: string; waitReason?: { kind: string } }>({ status: 'cancelled', lastTurnOutcome: 'interrupted' });
    const continueInterrupted = vi.fn().mockResolvedValue({ success: true });
    await TestBed.configureTestingModule({ imports: [InterruptedContinuationComponent], providers: [
      { provide: InstanceStore, useValue: { getInstance: () => instance() } },
      { provide: InstanceIpcService, useValue: { continueInterrupted } },
    ] }).compileComponents();
    const fixture = TestBed.createComponent(InterruptedContinuationComponent);
    fixture.componentRef.setInput('instanceId', 'session');
    fixture.detectChanges();
    return { fixture, instance, continueInterrupted, questions: TestBed.inject(UserInputRequestRegistry) };
  }

  it('offers Continue only for an interrupted session that is ready', async () => {
    const { fixture, instance } = await mount();
    expect(fixture.nativeElement.textContent).toContain('Continue');
    instance.set({ status: 'busy', lastTurnOutcome: 'interrupted' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it('sends the safe continuation once instead of replaying the old request', async () => {
    const { fixture, continueInterrupted } = await mount();
    fixture.nativeElement.querySelector('button').click();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('button')?.click();
    await fixture.whenStable();
    expect(continueInterrupted).toHaveBeenCalledOnce();
    expect(continueInterrupted).toHaveBeenCalledWith('session', SAFE_CONTINUATION, expect.any(String));
  });

  it('uses a different idempotency key after switching sessions', async () => {
    const { fixture, continueInterrupted } = await mount();
    fixture.nativeElement.querySelector('button').click();
    await fixture.whenStable();
    fixture.componentRef.setInput('instanceId', 'other-session');
    fixture.detectChanges();
    fixture.nativeElement.querySelector('button').click();
    await fixture.whenStable();
    expect(continueInterrupted).toHaveBeenCalledTimes(2);
    expect(continueInterrupted.mock.calls[0][2]).not.toBe(continueInterrupted.mock.calls[1][2]);
  });

  it('keeps an explicit failed send retryable and gives a safe error sentence', async () => {
    const { fixture, continueInterrupted } = await mount();
    continueInterrupted.mockResolvedValue({ success: false, error: { message: 'PRIVATE_DIAGNOSTIC' } });
    fixture.nativeElement.querySelector('button').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Couldn't continue");
    expect(fixture.nativeElement.textContent).not.toContain('PRIVATE_DIAGNOSTIC');
    expect(fixture.nativeElement.querySelector('button').disabled).toBe(false);
  });

  it('offers a new Continue after a later interruption in the same session', async () => {
    const { fixture, instance } = await mount();
    fixture.nativeElement.querySelector('button').click();
    await fixture.whenStable();
    instance.set({ status: 'busy', lastTurnOutcome: 'interrupted' });
    fixture.detectChanges();
    instance.set({ status: 'cancelled', lastTurnOutcome: 'interrupted' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button').disabled).toBe(false);
    expect(fixture.nativeElement.querySelector('button').textContent).toContain('Continue');
  });

  it('offers Continue again when the previous acknowledgement arrived after work resumed', async () => {
    const { fixture, instance, continueInterrupted } = await mount();
    let acknowledge!: (value: { success: boolean }) => void;
    continueInterrupted.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));
    fixture.nativeElement.querySelector('button').click();
    instance.set({ status: 'busy', lastTurnOutcome: 'interrupted' });
    fixture.detectChanges();
    acknowledge({ success: true });
    await fixture.whenStable();
    instance.set({ status: 'cancelled', lastTurnOutcome: 'interrupted' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button').disabled).toBe(false);
  });

  it('ignores an acknowledgement from before a later interruption', async () => {
    const { fixture, instance, continueInterrupted } = await mount();
    let acknowledge!: (value: { success: boolean }) => void;
    continueInterrupted.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));
    fixture.nativeElement.querySelector('button').click();
    instance.set({ status: 'busy', lastTurnOutcome: 'interrupted' });
    fixture.detectChanges();
    instance.set({ status: 'cancelled', lastTurnOutcome: 'interrupted' });
    fixture.detectChanges();
    acknowledge({ success: true });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button').disabled).toBe(false);
  });

  it('does not offer Continue over a question in a later active turn', async () => {
    const { fixture, instance } = await mount();
    instance.set({ status: 'waiting_for_input', lastTurnOutcome: 'interrupted', activeTurnId: 'new-turn' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it('hides Continue as soon as a question registers, even before a status update', async () => {
    const { fixture, questions } = await mount();
    questions.replace('card', [{ requestId: 'q', instanceId: 'session', createdAt: 1, answer: async () => 'answered' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
    questions.replace('card', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).not.toBeNull();
  });

  it.each(['backoff', 'quota-park', 'auth-required'])('does not override an active %s wait', async kind => {
    const { fixture, instance } = await mount();
    instance.set({ status: 'waiting_for_input', lastTurnOutcome: 'interrupted', waitReason: { kind } });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });
});
