/**
 * S4.2 wiring. The policy shaping is unit-tested in `routing-matrix.spec.ts`;
 * these prove a user can actually change a gate's tier, which is the part that
 * did not exist before — the setting was `surfacing: 'internal'` with no UI.
 */
import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RoutingMatrixComponent } from './routing-matrix.component';
import { SettingsStore } from '../../core/state/settings.store';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings-defaults';
import type { AppSettings } from '../../../../shared/types/settings.types';

await resolveComponentResources((url) =>
  (url.endsWith('.scss') ? Promise.resolve('') : Promise.reject(new Error(`unexpected ${url}`))));

function mount(policyJson = DEFAULT_SETTINGS.orchestrationRoutingPolicyJson) {
  const settings = signal<AppSettings>({
    ...DEFAULT_SETTINGS,
    orchestrationRoutingPolicyJson: policyJson,
  });
  const update = vi.fn(async (patch: Partial<AppSettings>) => {
    settings.update((cur) => ({ ...cur, ...patch }));
  });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [RoutingMatrixComponent],
    providers: [{ provide: SettingsStore, useValue: { settings, update } }],
  });
  const fixture = TestBed.createComponent(RoutingMatrixComponent);
  fixture.detectChanges();
  return { fixture, update, settings };
}

function rowLabels(fixture: ReturnType<typeof mount>['fixture']): string[] {
  return Array.from(fixture.nativeElement.querySelectorAll('.rm-gate-label'))
    .map((el) => (el as HTMLElement).textContent?.trim() ?? '');
}

describe('RoutingMatrixComponent (S4.2)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders a row for every orchestration gate', () => {
    expect(rowLabels(mount().fixture)).toEqual([
      'Loop iterations', 'Workflow tasks', 'Verify', 'Review', 'Debate rounds', 'Debate synthesis',
    ]);
  });

  it('offers every tier as a choice', () => {
    const { fixture } = mount();
    const options = Array.from(
      (fixture.nativeElement.querySelector('select') as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toEqual(['auto', 'fast', 'balanced', 'powerful']);
  });

  /** The wiring that did not exist: changing a tier must persist. */
  it('writes the whole policy when a tier changes', async () => {
    const { fixture, update } = mount();
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'fast';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(update).toHaveBeenCalledTimes(1);
    const written = JSON.parse(update.mock.calls[0]![0].orchestrationRoutingPolicyJson as string);
    expect(written.loop).toBe('fast');
    // Every key, not just the changed one.
    expect(Object.keys(written)).toHaveLength(6);
  });

  it('says what changed rather than writing silently', async () => {
    const { fixture } = mount();
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'powerful';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Loop iterations now runs on');
  });

  it('offers a reset only on a row that differs from its default', () => {
    const { fixture } = mount(JSON.stringify({ loop: 'fast' }));
    const resets = fixture.nativeElement.querySelectorAll('.rm-reset-btn');
    expect(resets).toHaveLength(1);
  });

  it('reset restores the shipped default', async () => {
    const { fixture, update } = mount(JSON.stringify({ loop: 'fast' }));
    (fixture.nativeElement.querySelector('.rm-reset-btn') as HTMLButtonElement).click();
    await fixture.whenStable();
    const written = JSON.parse(update.mock.calls[0]![0].orchestrationRoutingPolicyJson as string);
    expect(written.loop).toBe('balanced');
  });

  /** A settings typo must not blank the table. */
  it('still renders every row for a malformed policy blob', () => {
    expect(rowLabels(mount('{ not json').fixture)).toHaveLength(6);
  });
});
