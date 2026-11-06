import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../../core/state/automation.store';
import { LoopStore } from '../../core/state/loop.store';
import type { Instance } from '../../core/state/instance/instance.types';
import { IdleCacheHintComponent } from './idle-cache-hint.component';

const MIN = 60_000;
const START = new Date('2026-10-20T12:00:00Z').getTime();

describe('IdleCacheHintComponent', () => {
  let fixture: ComponentFixture<IdleCacheHintComponent>;
  const wakeUps = signal<unknown[]>([]);
  const activeLoop = signal<unknown>(undefined);

  function instance(patch: Partial<Instance> = {}): Instance {
    return {
      id: 'inst-1', provider: 'claude', status: 'idle', lastActivity: START - 10 * MIN,
      contextUsage: { used: 230_000, total: 1_000_000, percentage: 23, occupancyReported: true },
      outputBuffer: [],
      ...patch,
    } as unknown as Instance;
  }

  function mount(inst: Instance): void {
    fixture = TestBed.createComponent(IdleCacheHintComponent);
    fixture.componentRef.setInput('instance', inst);
    fixture.detectChanges();
  }

  const text = (): string | null => (fixture.nativeElement.querySelector('[data-testid="idle-cache-hint"]') as HTMLElement | null)?.textContent?.trim() ?? null;

  /** Move the clock and let the component's one-minute check notice. */
  function advance(minutes: number): void {
    vi.setSystemTime(Date.now() + minutes * MIN);
    vi.advanceTimersByTime(minutes * MIN > MIN ? MIN : minutes * MIN);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    wakeUps.set([]);
    activeLoop.set(undefined);
    await TestBed.configureTestingModule({
      imports: [IdleCacheHintComponent],
      providers: [
        { provide: AutomationStore, useValue: { threadWakeupsForInstance: () => wakeUps() } },
        { provide: LoopStore, useValue: { activeForChat: () => () => activeLoop() } },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
    vi.useRealTimers();
  });

  it('is hidden at first, then appears once the session has been idle for 75 minutes', () => {
    mount(instance());
    expect(text()).toBeNull();
    advance(70); // idle for 80 minutes now
    expect(text()).toBe('Starting something new? A fresh session would skip re-reading about 230K tokens.');
  });

  it('stays hidden while a scheduled wake-up or a loop expects the session', () => {
    wakeUps.set([{ id: 'a1' }]);
    mount(instance({ lastActivity: START - 90 * MIN }));
    expect(text()).toBeNull();

    wakeUps.set([]);
    activeLoop.set({ id: 'loop-1' });
    advance(1);
    expect(text()).toBeNull();

    activeLoop.set(undefined);
    advance(1);
    expect(text()).not.toBeNull();
  });

  it('can be dismissed, and comes back after the session has been used and left again', () => {
    mount(instance({ lastActivity: START - 90 * MIN }));
    expect(text()).not.toBeNull();
    (fixture.nativeElement.querySelector('.idle-cache-hint-dismiss') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(text()).toBeNull();

    fixture.componentRef.setInput('instance', instance({ lastActivity: Date.now() - 80 * MIN }));
    fixture.detectChanges();
    expect(text()).not.toBeNull();
  });

  it('offers a labelled dismiss button and stays silent for small or busy sessions', () => {
    mount(instance({ lastActivity: START - 90 * MIN }));
    expect((fixture.nativeElement.querySelector('.idle-cache-hint-dismiss') as HTMLButtonElement).getAttribute('aria-label')).toMatch(/dismiss/i);
    fixture.destroy();

    mount(instance({ lastActivity: START - 90 * MIN, contextUsage: { used: 50_000, total: 1_000_000, percentage: 5, occupancyReported: true } }));
    expect(text()).toBeNull();
    fixture.destroy();

    mount(instance({ lastActivity: START - 90 * MIN, status: 'busy' }));
    expect(text()).toBeNull();
  });
});
