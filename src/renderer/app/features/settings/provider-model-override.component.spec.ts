/**
 * S4.3 — the shared pin-a-model widget, driven for real.
 *
 * The behaviour worth pinning is the map write: reset must DELETE the key
 * rather than write an empty string, because the read path treats absence as
 * "follow the default" and an empty string as a pinned blank. Both copies of
 * this code got that right; a shared version has to keep getting it right.
 */
import { ChangeDetectionStrategy, Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderModelOverrideComponent } from './provider-model-override.component';
import { SettingsStore } from '../../core/state/settings.store';

await resolveComponentResources(() => Promise.resolve(''));

@Component({ selector: 'app-compact-model-picker', standalone: true, template: '' })
class PickerStub {}

@Component({
  standalone: true,
  imports: [ProviderModelOverrideComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-provider-model-override
      settingsKey="loopModelByProvider"
      provider="claude"
      unpinnedSourceLabel="Session default"
      resetLabel="Use default"
      resetAriaLabel="Use session default for Claude loops"
      [unpinnedModel]="'opus'"
    />
  `,
})
class HostComponent {}

describe('ProviderModelOverrideComponent (S4.3)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let map: Record<string, string>;
  const set = vi.fn();

  beforeEach(async () => {
    map = {};
    set.mockClear();
    const settings = signal<Record<string, unknown>>({ loopModelByProvider: map });

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        {
          provide: SettingsStore,
          useValue: {
            settings,
            get: (key: string) => (settings() as Record<string, unknown>)[key],
            set: (key: string, value: unknown) => {
              set(key, value);
              settings.update((s) => ({ ...s, [key]: value }));
            },
          },
        },
      ],
    });
    TestBed.overrideComponent(ProviderModelOverrideComponent, {
      set: { imports: [PickerStub], styles: [''], styleUrl: undefined, styleUrls: [] },
    });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  function widget(): ProviderModelOverrideComponent {
    return fixture.debugElement.children[0]!.componentInstance as ProviderModelOverrideComponent;
  }
  function sourceLabel(): string {
    return (fixture.nativeElement.querySelector('.provider-model-override__source') as HTMLElement)
      .textContent!.trim();
  }
  function resetButton(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('.provider-model-override__reset');
  }

  it('shows the caller’s unpinned wording when nothing is pinned', () => {
    expect(sourceLabel()).toBe('Session default');
  });

  it('disables reset when there is nothing to reset', () => {
    expect(resetButton().disabled).toBe(true);
  });

  it('uses the caller’s reset wording and accessible name', () => {
    expect(resetButton().textContent?.trim()).toBe('Use default');
    expect(resetButton().getAttribute('aria-label')).toBe('Use session default for Claude loops');
  });

  it('pins a model onto the map under its own provider key', () => {
    (widget() as unknown as { onPicked: (s: unknown) => void })
      .onPicked({ provider: 'claude', model: 'sonnet', reasoning: null });
    fixture.detectChanges();
    expect(set).toHaveBeenCalledWith('loopModelByProvider', { claude: 'sonnet' });
    expect(sourceLabel()).toBe('Pinned override');
    expect(resetButton().disabled).toBe(false);
  });

  it('ignores a selection emitted for a different provider', () => {
    (widget() as unknown as { onPicked: (s: unknown) => void })
      .onPicked({ provider: 'codex', model: 'gpt', reasoning: null });
    expect(set).not.toHaveBeenCalled();
  });

  it('ignores a selection with no model', () => {
    (widget() as unknown as { onPicked: (s: unknown) => void })
      .onPicked({ provider: 'claude', model: null, reasoning: null });
    expect(set).not.toHaveBeenCalled();
  });

  it('deletes the key on reset rather than writing an empty string', () => {
    (widget() as unknown as { onPicked: (s: unknown) => void })
      .onPicked({ provider: 'claude', model: 'sonnet', reasoning: null });
    fixture.detectChanges();
    set.mockClear();

    resetButton().click();
    fixture.detectChanges();
    const written = set.mock.calls[0]![1] as Record<string, string>;
    expect('claude' in written).toBe(false);
    expect(sourceLabel()).toBe('Session default');
  });

  it('leaves other providers’ pins untouched when one is reset', () => {
    (widget() as unknown as { onPicked: (s: unknown) => void })
      .onPicked({ provider: 'claude', model: 'sonnet', reasoning: null });
    fixture.detectChanges();
    // Another tab pinned a different provider in the meantime.
    TestBed.inject(SettingsStore).set('loopModelByProvider' as never, { claude: 'sonnet', codex: 'gpt' } as never);
    fixture.detectChanges();
    set.mockClear();

    resetButton().click();
    expect(set.mock.calls[0]![1]).toEqual({ codex: 'gpt' });
  });
});
