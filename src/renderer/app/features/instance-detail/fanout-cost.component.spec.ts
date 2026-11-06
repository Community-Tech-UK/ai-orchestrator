import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { FanoutCostComponent } from './fanout-cost.component';
import type { FanoutInstance } from './fanout-cost';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';

const node = (id: string, parentId: string | null, costEstimate?: number): FanoutInstance => ({ id, parentId, contextUsage: costEstimate === undefined ? {} : { costEstimate } });

describe('FanoutCostComponent', () => {
  const instances = signal<FanoutInstance[]>([]);
  const showCost = signal(true);

  beforeEach(() => {
    instances.set([]);
    showCost.set(true);
    TestBed.configureTestingModule({
      imports: [FanoutCostComponent],
      providers: [
        { provide: InstanceStore, useValue: { instances } },
        { provide: SettingsStore, useValue: { showCost } },
      ],
    });
  });

  function render(): HTMLElement {
    const fixture = TestBed.createComponent(FanoutCostComponent);
    fixture.componentRef.setInput('instanceId', 'lead');
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  const chip = (root: HTMLElement): string | null => root.querySelector('.fanout-cost')?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

  it('shows nothing for a session with no helpers', () => {
    instances.set([node('lead', null, 1)]);
    expect(chip(render())).toBeNull();
  });

  it('shows the helper count and the running cost', () => {
    instances.set([node('lead', null, 9), node('s1', 'lead', 0.4), node('s2', 'lead', 0.35)]);
    expect(chip(render())).toBe('2 helpers ≈$0.75');
  });

  it('marks a total that leaves out helpers with no reported cost, and says "1 helper" for one', () => {
    instances.set([node('lead', null), node('s1', 'lead', 0.4), node('s2', 'lead')]);
    expect(chip(render())).toBe('2 helpers ≈$0.40+');
    instances.set([node('lead', null), node('s1', 'lead', 0.2)]);
    expect(chip(render())).toBe('1 helper ≈$0.20');
  });

  it('shows the count but no dollars while nothing is priced, or when costs are switched off', () => {
    instances.set([node('lead', null), node('s1', 'lead')]);
    expect(chip(render())).toBe('1 helper');
    instances.set([node('lead', null), node('s1', 'lead', 3)]);
    showCost.set(false);
    expect(chip(render())).toBe('1 helper');
  });
});
