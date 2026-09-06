import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InlineHintComponent } from './inline-hint.component';
import { SettingsStore } from '../../core/state/settings.store';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings-defaults';
import type { AppSettings } from '../../../../shared/types/settings.types';
import type { HintId } from '../../../../shared/types/hint-policy';

await resolveComponentResources(() => Promise.resolve(''));

function mount(opts: { dismissed?: string[]; condition?: boolean; id?: HintId } = {}) {
  const settings = signal<AppSettings>({
    ...DEFAULT_SETTINGS,
    dismissedHints: opts.dismissed ?? [],
  });
  const update = vi.fn(async (patch: Partial<AppSettings>) => {
    settings.update((cur) => ({ ...cur, ...patch }));
  });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InlineHintComponent],
    providers: [{ provide: SettingsStore, useValue: { settings, update } }],
  });
  const fixture = TestBed.createComponent(InlineHintComponent);
  fixture.componentRef.setInput('hintId', opts.id ?? 'loop-config-first-open');
  fixture.componentRef.setInput('condition', opts.condition ?? true);
  fixture.detectChanges();
  return { fixture, update, settings };
}

describe('InlineHintComponent (UX5)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows an earned, undismissed hint', () => {
    const { fixture } = mount();
    expect(fixture.nativeElement.querySelector('.inline-hint')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('prove it is done');
  });

  it('renders nothing at all when the hint is not earned yet', () => {
    const { fixture } = mount({ condition: false });
    expect(fixture.nativeElement.querySelector('.inline-hint')).toBeNull();
  });

  it('renders nothing once dismissed', () => {
    const { fixture } = mount({ dismissed: ['loop-config-first-open'] });
    expect(fixture.nativeElement.querySelector('.inline-hint')).toBeNull();
  });

  /** Dismissal must persist, or the hint returns and becomes an advert. */
  it('persists the dismissal and disappears', async () => {
    const { fixture, update } = mount();
    fixture.nativeElement.querySelector('.inline-hint__dismiss').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(update).toHaveBeenCalledWith({ dismissedHints: ['loop-config-first-open'] });
    expect(fixture.nativeElement.querySelector('.inline-hint')).toBeNull();
  });

  it('keeps other dismissals when adding one', async () => {
    const { fixture, update } = mount({ dismissed: ['settings-overview-profiles'] });
    fixture.nativeElement.querySelector('.inline-hint__dismiss').click();
    await fixture.whenStable();
    expect(update.mock.calls[0]![0]).toEqual({
      dismissedHints: ['settings-overview-profiles', 'loop-config-first-open'],
    });
  });

  it('names the hint in the dismiss control, not just "Got it"', () => {
    const { fixture } = mount();
    const btn = fixture.nativeElement.querySelector('.inline-hint__dismiss');
    expect(btn.getAttribute('aria-label')).toContain('prove it is done');
  });
});
