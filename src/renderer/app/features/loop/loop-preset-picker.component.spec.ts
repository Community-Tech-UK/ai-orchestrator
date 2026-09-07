/**
 * B4 — the picker is presentational, and one test here enforces exactly that:
 * it must render the contract text it was GIVEN, never text it looked up
 * itself. That lookup is what produced the stale-contract bug.
 */
import { ChangeDetectionStrategy, Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { LoopPresetPickerComponent } from './loop-preset-picker.component';
import type { LoopPresetId, LoopPresetOverride } from './loop-presets';

await resolveComponentResources(() => Promise.resolve(''));

@Component({
  standalone: true,
  imports: [LoopPresetPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-loop-preset-picker
      [selectedPresetId]="selected()"
      [contractText]="contract()"
      [overrides]="overrides()"
      (presetSelected)="picked.push($event)"
      (presetReset)="resets = resets + 1"
    />
  `,
})
class HostComponent {
  readonly selected = signal<LoopPresetId | null>(null);
  readonly contract = signal('');
  readonly overrides = signal<LoopPresetOverride[]>([]);
  readonly picked: LoopPresetId[] = [];
  resets = 0;
}

describe('LoopPresetPickerComponent (B4)', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  function choices(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.loop-presets__choice'));
  }

  it('offers all four intents', () => {
    expect(choices()).toHaveLength(4);
    expect(fixture.nativeElement.textContent).toContain('Safe implementation');
    expect(fixture.nativeElement.textContent).toContain('Plan only');
  });

  it('emits the preset that was clicked', () => {
    choices()[1]!.click();
    expect(fixture.componentInstance.picked).toEqual(['investigate']);
  });

  it('marks the selection for assistive tech, not by colour alone', () => {
    fixture.componentInstance.selected.set('plan-only');
    fixture.detectChanges();
    const selected = choices().filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.getAttribute('data-preset-id')).toBe('plan-only');
  });

  /**
   * The load-bearing one. The picker must render what the host resolved; if it
   * ever looks the contract up itself again, this fails.
   */
  it('renders the contract text it was given, not text of its own', () => {
    fixture.componentInstance.selected.set('safe-implementation');
    fixture.componentInstance.contract.set('A summary built from the live values.');
    fixture.detectChanges();
    const contract = fixture.nativeElement.querySelector('.loop-presets__contract') as HTMLElement;
    expect(contract.textContent?.trim()).toBe('A summary built from the live values.');
    expect(fixture.nativeElement.textContent).not.toContain('never runs a destructive command');
  });

  it('shows no contract line when the host has nothing to say', () => {
    expect(fixture.nativeElement.querySelector('.loop-presets__contract')).toBeNull();
  });

  it('hides the changes drawer when nothing was overridden', () => {
    expect(fixture.nativeElement.querySelector('.loop-presets__overrides-toggle')).toBeNull();
  });

  it('counts the overrides on the drawer toggle', () => {
    fixture.componentInstance.overrides.set([
      { field: 'allowDestructive', label: 'Allow destructive commands', presetValue: false, currentValue: true },
    ]);
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.loop-presets__overrides-toggle') as HTMLElement)
      .textContent?.trim()).toBe('1 change from this preset');
  });

  it('lists each override as preset value then current value', () => {
    fixture.componentInstance.overrides.set([
      { field: 'allowDestructive', label: 'Allow destructive commands', presetValue: false, currentValue: true },
    ]);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.loop-presets__overrides-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('.loop-presets__override') as HTMLElement;
    expect(row.textContent).toContain('Allow destructive commands');
    expect(row.textContent).toContain('off');
    expect(row.textContent).toContain('on');
  });

  it('emits a reset from the drawer', () => {
    fixture.componentInstance.overrides.set([
      { field: 'maxDollars', label: 'Cost cap', presetValue: 20, currentValue: null },
    ]);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.loop-presets__overrides-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.loop-presets__reset') as HTMLButtonElement).click();
    expect(fixture.componentInstance.resets).toBe(1);
  });

  it('renders a null value as "none" rather than blank', () => {
    fixture.componentInstance.overrides.set([
      { field: 'maxDollars', label: 'Cost cap', presetValue: 20, currentValue: null },
    ]);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.loop-presets__overrides-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.loop-presets__override') as HTMLElement).textContent)
      .toContain('none');
  });
});
