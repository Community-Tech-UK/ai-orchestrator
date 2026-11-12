import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { InstanceEventsService } from '../../core/services/instance-events.service';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { ToastService } from '../../core/services/toast.service';
import { InstanceStore, type ContextUsage } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ContextDetailsPopoverComponent } from './context-details-popover.component';

await resolveComponentResources(async url => url.endsWith('context-evidence-panel.component.html')
  ? readFileSync(join(__dirname, '../../shared/components/context-evidence-panel', basename(url)), 'utf8') : '');

/** A usage the provider really reported (LT-018): `occupancyReported` separates it from the create-time placeholder. */
const reported = (overrides: Partial<ContextUsage> = {}): ContextUsage =>
  ({ used: 50_000, total: 100_000, percentage: 50, occupancyReported: true, ...overrides });

describe('ContextDetailsPopoverComponent', () => {
  let events: Subject<ProviderRuntimeEventEnvelope>;
  const previewCompaction = vi.fn();

  beforeEach(async () => {
    TestBed.resetTestingModule();
    events = new Subject<ProviderRuntimeEventEnvelope>();
    previewCompaction.mockReset().mockResolvedValue({ success: false, error: { message: 'preview not needed here' } });
    await TestBed.configureTestingModule({
      imports: [ContextDetailsPopoverComponent],
      providers: [
        { provide: InstanceStore, useValue: { getInstance: () => undefined, instances: () => [] } },
        { provide: SettingsStore, useValue: { showCost: () => true, settings: () => ({}) } },
        { provide: InstanceIpcService, useValue: { previewCompaction, applyCompactionWithOptions: vi.fn() } },
        { provide: InstanceEventsService, useValue: { events$: events.asObservable() } },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    }).compileComponents();
  });

  function render(usage: ContextUsage | undefined, isOpen = true, provider = 'claude') {
    const fixture = TestBed.createComponent(ContextDetailsPopoverComponent);
    fixture.componentRef.setInput('instanceId', 'session');
    fixture.componentRef.setInput('usage', usage);
    fixture.componentRef.setInput('provider', provider);
    fixture.componentRef.setInput('isOpen', isOpen);
    fixture.detectChanges();
    return fixture;
  }
  const text = (fixture: { nativeElement: HTMLElement }) => fixture.nativeElement.textContent?.replace(/\s+/g, ' ') ?? '';

  it('stays hidden until opened, and offers a labelled close', () => {
    const fixture = render(reported(), false);
    expect(fixture.nativeElement.querySelector('.context-details').hidden).toBe(true);
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    const dialog = fixture.nativeElement.querySelector('.context-details') as HTMLElement;
    expect(dialog.hidden).toBe(false);
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Context details');
    expect(fixture.nativeElement.querySelector('.heading button').getAttribute('aria-label')).toBe('Close Context details');
  });

  it('shows the real numbers for a provider that reports occupancy', () => {
    const fixture = render(reported());
    expect(fixture.nativeElement.querySelector('.used').textContent).toBe('50,000');
    expect(fixture.nativeElement.querySelector('.total').textContent).toBe('100,000');
    expect(fixture.nativeElement.querySelector('.percentage').textContent).toBe('(50%)');
  });

  it('never invents a measurement before the provider has reported one (LT-018)', () => {
    const fixture = render({ used: 0, total: 200_000, percentage: 0 });
    expect(fixture.nativeElement.querySelector('.used')).toBeNull();
    expect(text(fixture)).toContain('no data');
    expect(text(fixture)).not.toContain('0%');
    expect(text(fixture)).not.toContain('200,000');
  });

  it('shows spend, not a percentage, for a provider that only reports a running total (LT-034)', () => {
    const fixture = render(reported({ used: 190_000, total: 200_000, percentage: 95, occupancyIsAggregate: true }));
    expect(text(fixture)).toContain('190,000');
    expect(text(fixture)).toContain('tokens used');
    expect(text(fixture)).not.toContain('95%');
  });

  it('shows no cost: the header owns it', () => {
    const fixture = render(reported({ costEstimate: 12.34 }));
    expect(fixture.nativeElement.querySelector('.cost')).toBeNull();
    expect(text(fixture)).not.toContain('$');
  });

  it('carries the Where the context goes and Details toggles', () => {
    const fixture = render(reported());
    expect(text(fixture)).toContain('Where the context goes');
    expect(text(fixture)).toContain('Details');
    expect(text(fixture)).not.toContain('Usage');
  });

  it('leaves the context row out of the provider rows, because the ring already says it', () => {
    const fixture = render(reported());
    events.next({ instanceId: 'session', event: { kind: 'context', used: 50_000, total: 100_000, percentage: 50, occupancyReported: true } } as ProviderRuntimeEventEnvelope);
    events.next({ instanceId: 'session', event: { kind: 'complete', rateLimit: { remaining: 3 } } } as ProviderRuntimeEventEnvelope);
    fixture.detectChanges();
    const panel = fixture.nativeElement.querySelector('app-provider-diagnostics-panel') as HTMLElement;
    expect(panel.textContent).toContain('3 remaining');
    expect(panel.textContent).not.toContain('Context');
  });

  it('opens the compaction preview from "Compact now…"', () => {
    const fixture = render(reported());
    expect(fixture.nativeElement.querySelector('.cpd-overlay')).toBeNull();
    const compact = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
      .find(button => button.textContent?.trim() === 'Compact now…');
    expect(compact).toBeDefined();
    compact!.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cpd-overlay')).not.toBeNull();
    expect(previewCompaction).toHaveBeenCalledWith('session', expect.anything());
  });

  it('shows Copilot premium requests only for a Copilot session, and says so when unmeasured', () => {
    expect(text(render(reported(), true, 'claude'))).not.toContain('Premium requests used');
    expect(text(render(reported(), true, 'copilot'))).toContain('Premium requests used: unavailable');
    expect(text(render(reported({ copilotUsage: { compactions: 0, premiumRequests: 15.5 } }), true, 'copilot'))).toContain('Premium requests used: 15.5');
  });

  it('reports a rate-limit or spent-quota warning to the toolbar even while closed', () => {
    const fixture = render(reported(), false);
    expect(fixture.componentInstance.warningLabel()).toBeNull();
    events.next({ instanceId: 'session', event: { kind: 'complete', rateLimit: { remaining: 0 } } } as ProviderRuntimeEventEnvelope);
    fixture.detectChanges();
    expect(fixture.componentInstance.hasWarning()).toBe(true);
    expect(fixture.componentInstance.warningLabel()).toBe('Rate limit reached');
    events.next({ instanceId: 'session', event: { kind: 'complete', quota: { exhausted: true, message: 'quota exhausted' } } } as ProviderRuntimeEventEnvelope);
    fixture.detectChanges();
    expect(fixture.componentInstance.warningLabel()).toBe('Quota used up');
  });
});
