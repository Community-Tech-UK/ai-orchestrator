import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../core/state/instance.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { InstanceEventsService } from '../../core/services/instance-events.service';
import { ComposerToolbarComponent } from './composer-toolbar.component';
await resolveComponentResources(async url => url.endsWith('context-evidence-panel.component.html') ? readFileSync(join(__dirname, '../../shared/components/context-evidence-panel', basename(url)), 'utf8') : '');

describe('Calm composer controls', () => {
  let events: Subject<ProviderRuntimeEventEnvelope>;
  let live: Instance | undefined;
  beforeEach(async () => {
    TestBed.resetTestingModule(); live = undefined; events = new Subject<ProviderRuntimeEventEnvelope>();
    await TestBed.configureTestingModule({ imports: [ComposerToolbarComponent], providers: [
      { provide: InstanceStore, useValue: { getInstance: () => live } },
      { provide: SettingsStore, useValue: { showCost: () => true, settings: () => ({}) } },
      { provide: InstanceIpcService, useValue: { changeModel: vi.fn() } },
      { provide: InstanceEventsService, useValue: { events$: events.asObservable() } },
    ] }).compileComponents();
  });
  function render() {
    const f = TestBed.createComponent(ComposerToolbarComponent);
    f.componentRef.setInput('instanceId', 'session'); f.componentRef.setInput('provider', 'copilot'); f.detectChanges(); return f;
  }
  it('does not show a model chip for a permission-only queued flip', () => {
    const f = render(); f.componentRef.setInput('desiredRuntime', { provider: 'copilot', yoloMode: true }); f.detectChanges();
    expect(f.nativeElement.querySelector('.pending-model-chip')).toBeNull();
  });
  it('opens Context details from the focusable ring and closes with Escape', () => {
    const f = render(); const ring = f.nativeElement.querySelector('.ctx-ring-btn') as HTMLButtonElement;
    expect(ring.tabIndex).toBe(0); ring.click(); f.detectChanges();
    expect(ring.getAttribute('aria-expanded')).toBe('true'); expect(f.nativeElement.querySelector('.context-details').hidden).toBe(false);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); ring.dispatchEvent(escape); f.detectChanges();
    expect(escape.defaultPrevented).toBe(true); expect(f.componentInstance.contextOpen()).toBe(false); expect(document.activeElement).toBe(ring);
  });
  it('closes Context details from within the dialog and consumes Escape before the session sees it', () => {
    const f = render(); const ring = f.nativeElement.querySelector('.ctx-ring-btn') as HTMLButtonElement;
    ring.click(); f.detectChanges();
    const sessionEscape = vi.fn(); f.nativeElement.addEventListener('keydown', sessionEscape);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    f.nativeElement.querySelector('.context-details .heading button').dispatchEvent(escape); f.detectChanges();
    expect(escape.defaultPrevented).toBe(true); expect(sessionEscape).not.toHaveBeenCalled();
    expect(f.componentInstance.contextOpen()).toBe(false); expect(document.activeElement).toBe(ring);
  });
  it('exposes exhausted provider warnings beside the ring even while details are closed', () => {
    const f = render();
    events.next({ instanceId: 'session', event: { kind: 'complete', rateLimit: { remaining: 0 } } } as ProviderRuntimeEventEnvelope); f.detectChanges();
    expect(f.componentInstance.contextOpen()).toBe(false);
    const warning = f.nativeElement.querySelector('.pending-model-chip') as HTMLButtonElement;
    expect(warning.textContent).toContain('Rate limit reached'); warning.click(); f.detectChanges(); expect(f.componentInstance.contextOpen()).toBe(true);
  });
});
