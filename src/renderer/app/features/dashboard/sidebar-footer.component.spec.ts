/**
 * SidebarFooterComponent spec.
 *
 * This component had no spec at all, which is how LT-018's fleet-scope half
 * shipped unnoticed: the footer rendered a confident "0% ctx" for a fleet that
 * had simply not reported occupancy yet, because the stat was gated on
 * `total > 0` and every instance is seeded with a placeholder context window.
 *
 * These tests assert the RENDERED DOM rather than the computed signals —
 * computed-only assertions on a sibling component stayed green through exactly
 * this bug, because the defect lived in the template.
 */

import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { SidebarFooterComponent } from './sidebar-footer.component';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';

// The component's template is inline but its styleUrl is external, so TestBed
// cannot resolve its def without this. Styles are irrelevant here — these tests
// assert text content — so resolving them to blank is correct.
await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

interface FleetUsage {
  used: number;
  total: number;
  percentage: number;
  occupancyReported: boolean;
  costEstimate?: number;
}

/**
 * Nothing has reported, but the totals are non-zero.
 *
 * This shape is the whole point of the test. The bug was gating the stat on
 * `total > 0`, which was true the moment any instance existed because each is
 * seeded with a 200k placeholder window — so the footer showed "0% ctx". A
 * fixture with `total: 0` would pass under *either* gate and prove nothing;
 * this one fails unless the component keys off the flag.
 */
function unreported(costEstimate?: number): FleetUsage {
  return { used: 0, total: 600_000, percentage: 0, occupancyReported: false, ...(costEstimate !== undefined ? { costEstimate } : {}) };
}

function reported(percentage: number): FleetUsage {
  return { used: 50_000, total: 200_000, percentage, occupancyReported: true };
}

describe('SidebarFooterComponent', () => {
  let fixture: ComponentFixture<SidebarFooterComponent>;

  async function render(opts: {
    instanceCount: number;
    usage: FleetUsage;
    showCost?: boolean;
  }): Promise<string> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [SidebarFooterComponent],
      providers: [
        {
          provide: InstanceStore,
          useValue: {
            instanceCount: () => opts.instanceCount,
            totalContextUsage: () => opts.usage,
            costByProvider: () => [],
            instances: () => [],
          },
        },
        { provide: SettingsStore, useValue: { showCost: () => opts.showCost ?? true } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SidebarFooterComponent);
    fixture.detectChanges();
    return (fixture.nativeElement.textContent as string) ?? '';
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('does not render a context percentage when no instance has reported occupancy', async () => {
    const text = await render({ instanceCount: 3, usage: unreported() });

    expect(text).toContain('3 sessions');
    expect(text).not.toContain('% ctx');
    expect(text).not.toContain('0%');
  });

  it('renders the context percentage once something has reported', async () => {
    const text = await render({ instanceCount: 2, usage: reported(25) });

    expect(text).toContain('25% ctx');
  });

  it('still renders cost when occupancy was never reported', async () => {
    const text = await render({ instanceCount: 1, usage: unreported(2.5) });

    expect(text).not.toContain('% ctx');
    expect(text).toContain('2.50');
  });

  it('hides cost when the global cost setting is off', async () => {
    const text = await render({ instanceCount: 1, usage: unreported(2.5), showCost: false });

    expect(text).not.toContain('2.50');
  });

  it('renders nothing when there are no sessions and nothing to report', async () => {
    const text = await render({ instanceCount: 0, usage: unreported() });

    expect(text.trim()).toBe('');
  });
});
