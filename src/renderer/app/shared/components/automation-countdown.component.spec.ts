import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Automation, AutomationRun } from '../../../../shared/types/automation.types';
import { THREAD_WAKEUP_DEFERRED_BUSY } from '../../../../shared/utils/thread-wakeup-deferral';
import { AutomationStore } from '../../core/state/automation.store';
import { InstanceStore } from '../../core/state/instance.store';
import { AutomationCountdownComponent } from './automation-countdown.component';

const DUE = 100_000;
const automation = { id: 'a1', nextFireAt: null, destination: { kind: 'thread', instanceId: 'i1' } } as unknown as Automation;
const run = (extra: Partial<AutomationRun>) => ({ id: 'r1', automationId: 'a1', status: 'skipped', scheduledAt: DUE, ...extra }) as AutomationRun;

describe('automation countdown for a wake-up due during a busy turn', () => {
  const runs = signal<AutomationRun[]>([]);
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); runs.set([]); });
  function text(): string {
    TestBed.resetTestingModule();
    vi.useFakeTimers(); vi.setSystemTime(DUE + 5_000);
    TestBed.configureTestingModule({ providers: [
      { provide: AutomationStore, useValue: { runs } },
      { provide: InstanceStore, useValue: { getInstance: () => ({ status: 'busy' }) } },
    ] });
    const fixture = TestBed.createComponent(AutomationCountdownComponent);
    fixture.componentRef.setInput('automation', automation);
    fixture.detectChanges();
    const label = fixture.nativeElement.textContent as string;
    fixture.destroy();
    return label;
  }

  it('says it is waiting for the session while the held prompt is not delivered', () => {
    runs.set([run({ error: THREAD_WAKEUP_DEFERRED_BUSY, threadPromptDelivered: false })]);
    expect(text()).toContain('Due now, waiting for the session to be idle');
  });

  it('keeps saying so while the redelivery is in flight (delivery not yet confirmed)', () => {
    runs.set([run({ error: THREAD_WAKEUP_DEFERRED_BUSY, threadPromptDelivered: null })]);
    expect(text()).toContain('Due now, waiting for the session to be idle');
  });

  it('stops once the prompt is confirmed delivered, and ignores a skip that was not a deferral', () => {
    runs.set([run({ error: THREAD_WAKEUP_DEFERRED_BUSY, threadPromptDelivered: true })]);
    expect(text()).toContain('Next run unverified');
    runs.set([run({ error: 'That conversation was busy, so nothing was sent. The next scheduled run will try again.', threadPromptDelivered: false })]);
    expect(text()).toContain('Next run unverified');
  });
});
