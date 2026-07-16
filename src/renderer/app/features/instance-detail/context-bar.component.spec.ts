/**
 * Unit tests for ContextBarComponent.
 *
 * Covers:
 * - Existing occupancy-bar rendering (percentage cap, estimated badge,
 *   compact vs detailed modes) stays intact.
 * - The new context-evidence-panel affordance: hidden with no `instanceId`,
 *   shown when provided, and — critically — the evidence scope is derived
 *   solely from real `instance.contextEvidence.conversationId` state (never
 *   fabricated), with an explicit "not linked yet" state when absent.
 * - The occupancy/percentage figures are never affected by evidence scope
 *   resolution (storage size vs. context occupancy stay separate).
 *
 * `ContextEvidencePanelComponent` has its own templateUrl/styleUrl and its
 * own dedicated spec; here it's swapped for an inline stub so this file
 * doesn't need to resolve its external resources.
 */

import { Component, input, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContextEvidenceScope } from '@contracts/types/context-evidence';
import { ContextBarComponent } from './context-bar.component';
import { ContextEvidencePanelComponent } from '../../shared/components/context-evidence-panel/context-evidence-panel.component';
import { InstanceStore, type ContextUsage, type Instance } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';

// ContextBarComponent's own template is inline, but it statically imports
// ContextEvidencePanelComponent (external templateUrl/styleUrl). TestBed's
// module graph walk resolves that component's def before applying the
// below override, so its external resources must still resolve to
// something (blank is fine — it's swapped for an inline stub either way).
await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

@Component({
  selector: 'app-context-evidence-panel',
  standalone: true,
  template: '<div class="stub-panel"></div>',
})
class ContextEvidencePanelStubComponent {
  scope = input<ContextEvidenceScope | null>(null);
}

function usage(overrides: Partial<ContextUsage> = {}): ContextUsage {
  return { used: 50, total: 100, percentage: 50, ...overrides };
}

describe('ContextBarComponent', () => {
  let fixture: ComponentFixture<ContextBarComponent>;
  const instances = new Map<string, Instance>();
  const fakeInstanceStore = { getInstance: (id: string) => instances.get(id) };
  const fakeSettingsStore = { showCost: () => true };

  beforeEach(async () => {
    instances.clear();

    TestBed.overrideComponent(ContextBarComponent, {
      remove: { imports: [ContextEvidencePanelComponent] },
      add: { imports: [ContextEvidencePanelStubComponent] },
    });
    await TestBed.configureTestingModule({
      imports: [ContextBarComponent],
      providers: [
        { provide: InstanceStore, useValue: fakeInstanceStore },
        { provide: SettingsStore, useValue: fakeSettingsStore },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ContextBarComponent);
    setUsage(fixture.componentInstance, usage());
  });

  function setUsage(component: ContextBarComponent, value: ContextUsage): void {
    (component as unknown as { usage: () => ContextUsage }).usage = () => value;
  }

  function setInstanceId(component: ContextBarComponent, id: string | null): void {
    (component as unknown as { instanceId: () => string | null }).instanceId = () => id;
  }

  function setShowDetails(component: ContextBarComponent, value: boolean): void {
    (component as unknown as { showDetails: () => boolean }).showDetails = () => value;
  }

  describe('existing occupancy rendering', () => {
    it('caps the bar fill at 100% for over-budget usage', () => {
      setUsage(fixture.componentInstance, usage({ used: 150, total: 100 }));
      fixture.detectChanges();

      const fill = fixture.nativeElement.querySelector('.bar-fill') as HTMLElement;
      expect(fill.style.width).toBe('100%');
    });

    it('shows the estimated badge and tilde markers when usage.isEstimated is true', () => {
      setUsage(fixture.componentInstance, usage({ isEstimated: true }));
      setShowDetails(fixture.componentInstance, true);
      fixture.detectChanges();

      const text = fixture.nativeElement.textContent as string;
      expect(fixture.nativeElement.querySelector('.estimated-badge')).toBeTruthy();
      expect(text).toContain('~50%');
    });

    it('shows a compact percentage label when showDetails is false', () => {
      setShowDetails(fixture.componentInstance, false);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.compact-label')?.textContent).toContain('50%');
      expect(fixture.nativeElement.querySelector('.bar-details')).toBeFalsy();
    });
  });

  describe('context evidence panel affordance', () => {
    it('shows no evidence toggle when no instanceId is provided', () => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.evidence-toggle')).toBeFalsy();
    });

    it('shows the evidence toggle when an instanceId is provided', () => {
      setInstanceId(fixture.componentInstance, 'inst-1');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.evidence-toggle')).toBeTruthy();
    });

    it('opens the real conversation scope panel when the instance has linked context evidence', () => {
      instances.set('inst-1', { id: 'inst-1', contextEvidence: { conversationId: 'conv-1' } } as Instance);
      setInstanceId(fixture.componentInstance, 'inst-1');
      fixture.detectChanges();

      // Derived scope is asserted on the parent's own computed signal — the
      // vitest harness has no Angular compiler plugin, so signal-input
      // property bindings into a child (`[scope]="scope"`) aren't reliably
      // observable through the child's DOM in this test environment.
      expect(fixture.componentInstance.evidenceScope()).toEqual({
        conversationId: 'conv-1',
        owner: { kind: 'instance', instanceId: 'inst-1' },
      });

      const toggle = fixture.nativeElement.querySelector('.evidence-toggle') as HTMLButtonElement;
      toggle.click();
      fixture.detectChanges();

      const stub = fixture.nativeElement.querySelector('.stub-panel');
      expect(stub).toBeTruthy();
      expect(fixture.nativeElement.querySelector('.evidence-unavailable')).toBeFalsy();
    });

    it('shows an explicit "not linked" state rather than fabricating a scope when the instance has no conversation id', () => {
      instances.set('inst-1', { id: 'inst-1' } as Instance);
      setInstanceId(fixture.componentInstance, 'inst-1');
      fixture.detectChanges();

      const toggle = fixture.nativeElement.querySelector('.evidence-toggle') as HTMLButtonElement;
      toggle.click();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.stub-panel')).toBeFalsy();
      expect(fixture.nativeElement.querySelector('.evidence-unavailable')?.textContent)
        .toMatch(/no context evidence conversation is linked/i);
    });

    it('reflects toggle state via aria-expanded and toggles closed again on second click', () => {
      instances.set('inst-1', { id: 'inst-1', contextEvidence: { conversationId: 'conv-1' } } as Instance);
      setInstanceId(fixture.componentInstance, 'inst-1');
      fixture.detectChanges();

      const toggle = fixture.nativeElement.querySelector('.evidence-toggle') as HTMLButtonElement;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');

      toggle.click();
      fixture.detectChanges();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(fixture.nativeElement.querySelector('.stub-panel')).toBeTruthy();

      toggle.click();
      fixture.detectChanges();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(fixture.nativeElement.querySelector('.stub-panel')).toBeFalsy();
    });

    it('never lets evidence-scope resolution influence the occupancy percentage figure', () => {
      instances.set('inst-1', { id: 'inst-1', contextEvidence: { conversationId: 'conv-1' } } as Instance);
      setInstanceId(fixture.componentInstance, 'inst-1');
      setUsage(fixture.componentInstance, usage({ used: 25, total: 100 }));
      setShowDetails(fixture.componentInstance, false);
      fixture.detectChanges();

      expect(fixture.componentInstance.percentage()).toBe(25);
      const toggle = fixture.nativeElement.querySelector('.evidence-toggle') as HTMLButtonElement;
      toggle.click();
      fixture.detectChanges();

      expect(fixture.componentInstance.percentage()).toBe(25);
    });
  });
});
