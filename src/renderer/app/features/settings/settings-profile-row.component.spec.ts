/**
 * S4.1 wiring. The profiles were built and correctly labelled NOT WIRED in a
 * first pass; these tests exist because that label can only be removed by
 * proving a user can actually apply one.
 */
import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsProfileRowComponent } from './settings-profile-row.component';
import { SettingsStore } from '../../core/state/settings.store';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings-defaults';
import { OVERNIGHT_PROFILE } from '../../../../shared/types/settings-profiles';
import type { AppSettings } from '../../../../shared/types/settings.types';

await resolveComponentResources(() => Promise.resolve(''));

function mount(initial: Partial<AppSettings> = {}) {
  const settings = signal<AppSettings>({ ...DEFAULT_SETTINGS, ...initial });
  const update = vi.fn(async (patch: Partial<AppSettings>) => {
    settings.update((cur) => ({ ...cur, ...patch }));
  });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SettingsProfileRowComponent],
    providers: [{ provide: SettingsStore, useValue: { settings, update } }],
  });
  const fixture = TestBed.createComponent(SettingsProfileRowComponent);
  fixture.detectChanges();
  return { fixture, update, settings };
}

function buttons(fixture: ReturnType<typeof mount>['fixture']): HTMLButtonElement[] {
  return Array.from(fixture.nativeElement.querySelectorAll('.profile-btn'));
}

describe('SettingsProfileRowComponent (S4.1)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders a button per profile', () => {
    const { fixture } = mount();
    expect(buttons(fixture).map((b) => b.textContent?.trim())).toEqual(['Overnight', 'Interactive']);
  });

  it('reports Interactive as active on shipped defaults', () => {
    const { fixture } = mount();
    expect(fixture.nativeElement.textContent).toContain('Currently: Interactive');
  });

  /** The whole point of the wiring: applying must actually write settings. */
  it('applies the profile values when clicked', async () => {
    const { fixture, update } = mount();
    buttons(fixture)[0]!.click();
    await fixture.whenStable();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject(OVERNIGHT_PROFILE.values);
  });

  it('says what it changed rather than applying silently', async () => {
    const { fixture } = mount();
    buttons(fixture)[0]!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Applied Overnight');
    expect(text).toContain('toolLoopAutoInterrupt');
  });

  it('disables the profile that is already active', () => {
    const { fixture } = mount();
    const [, interactive] = buttons(fixture);
    expect(interactive!.disabled).toBe(true);
  });

  it('reports a hand-tuned mix as custom rather than naming a profile', () => {
    const { fixture } = mount({ toolLoopAutoInterrupt: true });
    expect(fixture.nativeElement.textContent).toContain('Currently: custom');
  });

  it('does not write when the profile is already fully applied', async () => {
    const { fixture, update } = mount({ ...OVERNIGHT_PROFILE.values });
    // Overnight is active, so its button is disabled; call the handler directly.
    (fixture.componentInstance as unknown as {
      apply: (p: typeof OVERNIGHT_PROFILE) => Promise<void>;
    }).apply(OVERNIGHT_PROFILE);
    await fixture.whenStable();
    expect(update).not.toHaveBeenCalled();
  });
});
