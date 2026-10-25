import { Component, EventEmitter, Input, Output } from '@angular/core';
import { By } from '@angular/platform-browser';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { OrchestrationSettingsTabComponent } from './orchestration-settings-tab.component';
import { SettingsStore } from '../../core/state/settings.store';
import { OPENAI_MODELS } from '../../../../shared/types/provider.types';
import { SettingRowComponent } from './setting-row.component';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';
import { ProviderModelOverrideComponent } from './provider-model-override.component';
import { SettingsTieredRowListComponent } from './settings-tiered-row-list.component';
import { WorkloadSliderComponent } from '../../core/state/global-pause/workload-slider.component';

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

class FakeSettingsStore {
  private values: Record<string, unknown> = {
    loopModelByProvider: { codex: OPENAI_MODELS.GPT56_TERRA },
  };

  readonly orchestrationSettings = vi.fn(() => []);
  readonly get = vi.fn((key: string) => this.values[key]);
  readonly set = vi.fn(async (key: string, value: unknown) => {
    this.values[key] = value;
  });

}

@Component({
  selector: 'app-compact-model-picker',
  standalone: true,
  template: '',
})
class CompactModelPickerStubComponent {
  @Input() mode: unknown;
  @Input() providers: PickerProvider[] | null = null;
  @Input() selection: PendingSelection | null = null;
  @Output() selectionChange = new EventEmitter<PendingSelection>();
}

describe('OrchestrationSettingsTabComponent', () => {
  let fixture: ComponentFixture<OrchestrationSettingsTabComponent>;
  let store: FakeSettingsStore;

  beforeEach(async () => {
    store = new FakeSettingsStore();
    TestBed.configureTestingModule({
      imports: [OrchestrationSettingsTabComponent],
      providers: [
        { provide: SettingsStore, useValue: store },
      ],
    });
        // S4.3 moved the picker inside ProviderModelOverrideComponent, so stubbing
    // only this tab's imports no longer reaches it.
    TestBed.overrideComponent(ProviderModelOverrideComponent, {
      set: { imports: [CompactModelPickerStubComponent], styles: [''], styleUrl: undefined, styleUrls: [] },
    });
    TestBed.overrideComponent(OrchestrationSettingsTabComponent, {
      set: {
        imports: [
          SettingRowComponent,
          CompactModelPickerStubComponent,
          SettingsTieredRowListComponent,
          ProviderModelOverrideComponent,
          WorkloadSliderComponent,
        ],
        styles: [''],
        styleUrl: undefined,
        styleUrls: [],
      },
    });
    await TestBed.compileComponents();

    fixture = TestBed.createComponent(OrchestrationSettingsTabComponent);
  });

  it('renders a loop model picker for every loop-capable provider', () => {
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent ?? '';
    expect(text).toContain('Loop model');
    for (const label of ['Claude Code', 'OpenAI Codex CLI', 'Antigravity', 'Cursor CLI']) {
      expect(text).toContain(label);
    }
  });

  it('shows the configured loop model in the shared session picker', () => {
    fixture.detectChanges();

    const codexPicker = pickerFor('codex');
    expect(codexPicker.providers).toEqual(['codex']);
    expect(codexPicker.selection).toEqual({
      provider: 'codex',
      model: OPENAI_MODELS.GPT56_TERRA,
      reasoning: null,
    });
  });

  it('persists a new loop model choice', () => {
    fixture.detectChanges();

    pickerFor('codex').selectionChange.emit({
      provider: 'codex',
      model: OPENAI_MODELS.GPT56_LUNA,
      reasoning: null,
    });

    expect(store.set).toHaveBeenCalledWith('loopModelByProvider', {
      codex: OPENAI_MODELS.GPT56_LUNA,
    });
  });

  it('drops the key when set back to the session default', () => {
    fixture.detectChanges();

    const reset = fixture.nativeElement.querySelector(
      'button[aria-label="Use session default for OpenAI Codex CLI loops"]',
    ) as HTMLButtonElement;
    reset.click();

    expect(store.set).toHaveBeenCalledWith('loopModelByProvider', {});
  });

  it('falls back to the session default for providers with no entry', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Session default');
    expect(pickerFor('claude').selection?.provider).toBe('claude');
  });

  it('renders one concurrency box per gated provider with its default cap', () => {
    fixture.detectChanges();

    const openCode = fixture.nativeElement.querySelector('#concurrency-opencode') as HTMLInputElement;
    const copilot = fixture.nativeElement.querySelector('#concurrency-copilot') as HTMLInputElement;
    expect(openCode.value).toBe('20');
    expect(copilot.value).toBe('10');
  });

  it('persists a concurrency change for one provider', () => {
    fixture.detectChanges();

    const openCode = fixture.nativeElement.querySelector('#concurrency-opencode') as HTMLInputElement;
    openCode.value = '30';
    openCode.dispatchEvent(new Event('change'));

    expect(store.set).toHaveBeenCalledWith('concurrencyLimitByProvider', { opencode: 30 });
  });

  it('ignores an out-of-range concurrency edit', () => {
    fixture.detectChanges();

    const openCode = fixture.nativeElement.querySelector('#concurrency-opencode') as HTMLInputElement;
    openCode.value = '0';
    openCode.dispatchEvent(new Event('change'));

    expect(store.set).not.toHaveBeenCalled();
    expect(openCode.value).toBe('20');
  });

  it('anchors the bespoke concurrency section for settings search jumps', () => {
    fixture.detectChanges();

    const section = fixture.nativeElement.querySelector(
      '[data-setting-key="concurrencyLimitByProvider"]',
    );
    expect(section).toBeTruthy();
  });

  it('preserves other providers caps when one box changes', async () => {
    await store.set('concurrencyLimitByProvider', { antigravity: 10, opencode: 20 });
    store.set.mockClear();
    fixture.detectChanges();

    const openCode = fixture.nativeElement.querySelector('#concurrency-opencode') as HTMLInputElement;
    openCode.value = '30';
    openCode.dispatchEvent(new Event('change'));

    expect(store.set).toHaveBeenCalledWith('concurrencyLimitByProvider', {
      antigravity: 10,
      opencode: 30,
    });
  });

  function pickerFor(provider: string): CompactModelPickerStubComponent {
    const picker = fixture.debugElement
      .queryAll(By.directive(CompactModelPickerStubComponent))
      .map((debugElement) => debugElement.componentInstance as CompactModelPickerStubComponent)
      .find((candidate) => candidate.providers?.[0] === provider);
    if (!picker) throw new Error(`No loop model picker for ${provider}`);
    return picker;
  }
});
