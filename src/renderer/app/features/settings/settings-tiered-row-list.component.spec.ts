/**
 * S3.2 — rendered for real, because the whole point is what shows on screen.
 *
 * The advanced-toggle's class name is part of the contract, not styling: the
 * settings search clicks it to reveal a collapsed row before scrolling. A test
 * asserts it explicitly so renaming the class breaks here rather than silently
 * making search land on nothing.
 */
import { ChangeDetectionStrategy, Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { SettingsTieredRowListComponent } from './settings-tiered-row-list.component';
import type { SettingMetadata } from '../../../../shared/types/settings-metadata.types';

await resolveComponentResources(() => Promise.resolve(''));

function meta(over: { key: string } & Partial<Omit<SettingMetadata, 'key'>>): SettingMetadata {
  return {
    label: over.key,
    description: 'What it does',
    type: 'boolean',
    category: 'general',
    ...over,
  } as unknown as SettingMetadata;
}

@Component({
  standalone: true,
  imports: [SettingsTieredRowListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-settings-tiered-row-list
      [settings]="settings()"
      [valueFor]="read"
      (valueChange)="changes.push($event)"
    />
  `,
})
class HostComponent {
  readonly settings = signal<SettingMetadata[]>([]);
  readonly changes: { key: string; value: unknown }[] = [];
  readonly read = (key: string): unknown => `value-for-${key}`;
}

describe('SettingsTieredRowListComponent (S3.2)', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
  });

  function rows(): Element[] {
    return Array.from(fixture.nativeElement.querySelectorAll('app-setting-row'));
  }

  function toggle(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('.settings-tiered-row-list__advanced-toggle');
  }

  it('renders common rows immediately', () => {
    fixture.componentInstance.settings.set([meta({ key: 'a' }), meta({ key: 'b' })]);
    fixture.detectChanges();
    expect(rows()).toHaveLength(2);
    expect(toggle()).toBeNull();
  });

  it('collapses advanced rows behind a toggle that states the count', () => {
    fixture.componentInstance.settings.set([
      meta({ key: 'a' }),
      meta({ key: 'n1', type: 'number' }),
      meta({ key: 'n2', type: 'number' }),
    ]);
    fixture.detectChanges();
    expect(rows()).toHaveLength(1);
    expect(toggle()?.textContent?.trim()).toBe('2 more advanced settings — Show advanced');
  });

  it('reveals the advanced rows when the toggle is pressed', () => {
    fixture.componentInstance.settings.set([meta({ key: 'a' }), meta({ key: 'n1', type: 'number' })]);
    fixture.detectChanges();
    toggle()!.click();
    fixture.detectChanges();
    expect(rows()).toHaveLength(2);
    expect(toggle()?.textContent?.trim()).toBe('Hide advanced settings');
  });

  it('reports its expanded state to assistive tech', () => {
    fixture.componentInstance.settings.set([meta({ key: 'n1', type: 'number' })]);
    fixture.detectChanges();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    toggle()!.click();
    fixture.detectChanges();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows no toggle when nothing is advanced', () => {
    fixture.componentInstance.settings.set([meta({ key: 'a' }), meta({ key: 'b' })]);
    fixture.detectChanges();
    expect(toggle()).toBeNull();
  });

  it('renders nothing at all for an empty list', () => {
    fixture.componentInstance.settings.set([]);
    fixture.detectChanges();
    expect(rows()).toHaveLength(0);
    expect(toggle()).toBeNull();
  });

  it('keeps the flat-list class every migrated tab depends on', () => {
    fixture.componentInstance.settings.set([meta({ key: 'a' })]);
    fixture.detectChanges();
    expect(rows()[0]?.classList.contains('settings-list-item')).toBe(true);
  });

  it('reads each value through the caller’s own getter', () => {
    fixture.componentInstance.settings.set([meta({ key: 'a', type: 'string' })]);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('app-setting-row input') as HTMLInputElement;
    expect(input.value).toBe('value-for-a');
  });
});
