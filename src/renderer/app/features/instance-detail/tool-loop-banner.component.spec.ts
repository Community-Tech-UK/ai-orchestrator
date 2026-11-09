/**
 * The in-session decision bar for a session that may be stuck.
 *
 * Drives the real `ToolLoopAlertStore` through a fake IPC channel and a fake
 * instance store, so "Let it continue" and "Stop this turn" are checked by what
 * the user then sees, not by which method was called.
 */
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';
import { ToolLoopBannerComponent } from './tool-loop-banner.component';

describe('ToolLoopBannerComponent', () => {
  let emit: (payload: Record<string, unknown>) => void;
  let fixture: ComponentFixture<ToolLoopBannerComponent>;
  const instances = signal([{ id: 'i1', status: 'busy' }, { id: 'i2', status: 'busy' }]);
  const interruptInstance = vi.fn<(id: string) => Promise<boolean>>();
  const parkQueueAfterInterrupt = vi.fn();

  const critical = (instanceId = 'i1') => ({
    instanceId, detector: 'repeat-no-progress', severity: 'critical',
    toolName: 'Bash', count: 12, windowDescription: '6 consecutive identical calls', harnessStopping: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    instances.set([{ id: 'i1', status: 'busy' }, { id: 'i2', status: 'busy' }]);
    interruptInstance.mockResolvedValue(true);
    TestBed.configureTestingModule({
      imports: [ToolLoopBannerComponent],
      providers: [
        { provide: IpcFacadeService, useValue: { on: (_channel: string, cb: typeof emit) => { emit = cb; return () => undefined; } } },
        { provide: InstanceStore, useValue: { instances, interruptInstance, parkQueueAfterInterrupt, isQueueParked: () => false, resumeParkedQueue: vi.fn() } },
      ],
    });
    fixture = TestBed.createComponent(ToolLoopBannerComponent);
    fixture.componentRef.setInput('instanceId', 'i1');
    fixture.detectChanges();
  });

  afterEach(() => TestBed.resetTestingModule());

  const element = () => fixture.nativeElement as HTMLElement;
  const button = (label: string) => [...element().querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

  it('shows nothing while the session is working normally', () => {
    expect(element().querySelector('.tool-loop-bar')).toBeNull();
  });

  it('says what the session has been doing and offers both choices', () => {
    emit(critical());
    fixture.detectChanges();
    expect(element().textContent).toContain('This session may be stuck.');
    expect(element().textContent).toContain('It has run Bash 12 times in a row and got the same result each time.');
    // Letting it carry on keeps spending, so the bar says so beside the choice, not only in a tooltip.
    expect(element().textContent).toContain("If you let it continue, it keeps working and you won't be asked about this again this turn.");
    expect(button('Stop this turn')).toBeDefined();
    expect(button('Let it continue')).toBeDefined();
  });

  it('ignores another session that may be stuck', () => {
    emit(critical('i2'));
    fixture.detectChanges();
    expect(element().querySelector('.tool-loop-bar')).toBeNull();
  });

  it('"Let it continue" removes the bar without stopping anything', () => {
    emit(critical());
    fixture.detectChanges();
    button('Let it continue')!.click();
    fixture.detectChanges();
    expect(element().querySelector('.tool-loop-bar')).toBeNull();
    expect(interruptInstance).not.toHaveBeenCalled();
  });

  it('"Stop this turn" shows progress, stops the session and removes the bar', async () => {
    let finish!: (value: boolean) => void;
    interruptInstance.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    emit(critical());
    fixture.detectChanges();
    button('Stop this turn')!.click();
    fixture.detectChanges();
    expect(button('Stopping…')?.disabled).toBe(true);
    expect(button('Let it continue')?.disabled).toBe(true);
    // Switching away and back keeps the stop in progress, so it cannot be sent twice.
    fixture.componentRef.setInput('instanceId', 'i2'); fixture.detectChanges();
    fixture.componentRef.setInput('instanceId', 'i1'); fixture.detectChanges();
    expect(button('Stopping…')?.disabled).toBe(true);
    expect(parkQueueAfterInterrupt).toHaveBeenCalledWith('i1');
    expect(interruptInstance).toHaveBeenCalledWith('i1');
    finish(true);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element().querySelector('.tool-loop-bar')).toBeNull();
  });

  it('says so when the turn will not stop, and keeps the choices', async () => {
    interruptInstance.mockResolvedValueOnce(false);
    emit(critical());
    fixture.detectChanges();
    button('Stop this turn')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element().querySelector('[role="alert"]')?.textContent).toContain('Could not stop this turn. Try the Stop button.');
    expect(button('Stop this turn')?.disabled).toBe(false);
  });

  it('does not show an old failure when a later turn raises a new alert', async () => {
    interruptInstance.mockResolvedValueOnce(false);
    emit(critical());
    fixture.detectChanges();
    button('Stop this turn')!.click();
    await fixture.whenStable(); fixture.detectChanges();
    expect(element().querySelector('[role="alert"]')).not.toBeNull();
    instances.set([{ id: 'i1', status: 'idle' }, { id: 'i2', status: 'busy' }]);
    fixture.detectChanges();
    instances.set([{ id: 'i1', status: 'busy' }, { id: 'i2', status: 'busy' }]);
    await new Promise((resolve) => setTimeout(resolve, 2)); // a new detection gets a later timestamp
    emit(critical());
    fixture.detectChanges();
    expect(element().querySelector('.tool-loop-bar')).not.toBeNull();
    expect(element().querySelector('[role="alert"]')).toBeNull();
  });

  it('clears by itself once the turn ends', () => {
    emit(critical());
    fixture.detectChanges();
    instances.set([{ id: 'i1', status: 'idle' }, { id: 'i2', status: 'busy' }]);
    fixture.detectChanges();
    expect(element().querySelector('.tool-loop-bar')).toBeNull();
    // ...and stays gone when the next turn starts.
    instances.set([{ id: 'i1', status: 'busy' }, { id: 'i2', status: 'busy' }]);
    fixture.detectChanges();
    expect(element().querySelector('.tool-loop-bar')).toBeNull();
  });
});
