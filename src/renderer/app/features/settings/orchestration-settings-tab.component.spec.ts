import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { OrchestrationSettingsTabComponent } from './orchestration-settings-tab.component';
import { SettingsStore } from '../../core/state/settings.store';
import { UnifiedCatalogStore } from '../models/unified-catalog.store';
import { OPENAI_MODELS } from '../../../../shared/types/provider.types';

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

  setValue(key: string, value: unknown): void {
    this.values[key] = value;
  }

  valueOf(key: string): unknown {
    return this.values[key];
  }
}

class FakeUnifiedCatalogStore {
  readonly ensureLoaded = vi.fn();
  // Empty live catalogue → the component falls back to the static model list.
  readonly displayModelsForProvider = vi.fn(() => []);
}

describe('OrchestrationSettingsTabComponent', () => {
  let fixture: ComponentFixture<OrchestrationSettingsTabComponent>;
  let store: FakeSettingsStore;

  const selectFor = (provider: string): HTMLSelectElement => {
    const label = { codex: 'OpenAI Codex CLI', claude: 'Claude Code' }[provider] ?? provider;
    const element = fixture.nativeElement.querySelector(
      `select[aria-label="${label} loop model"]`,
    ) as HTMLSelectElement | null;
    if (!element) throw new Error(`No loop model select for ${provider}`);
    return element;
  };

  beforeEach(async () => {
    store = new FakeSettingsStore();
    await TestBed.configureTestingModule({
      imports: [OrchestrationSettingsTabComponent],
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: UnifiedCatalogStore, useClass: FakeUnifiedCatalogStore },
      ],
    }).compileComponents();

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

  it('shows the configured loop model rather than the interactive default', () => {
    fixture.detectChanges();

    // The regression: loops used to silently follow the codex session default
    // (gpt-5.6-sol). The picker must show what loops will actually run.
    expect(selectFor('codex').value).toBe(OPENAI_MODELS.GPT56_TERRA);
  });

  it('persists a new loop model choice', () => {
    fixture.detectChanges();

    const select = selectFor('codex');
    select.value = OPENAI_MODELS.GPT56_LUNA;
    select.dispatchEvent(new Event('change'));

    expect(store.set).toHaveBeenCalledWith('loopModelByProvider', {
      codex: OPENAI_MODELS.GPT56_LUNA,
    });
  });

  it('drops the key when set back to the session default', () => {
    fixture.detectChanges();

    const select = selectFor('codex');
    select.value = '';
    select.dispatchEvent(new Event('change'));

    expect(store.set).toHaveBeenCalledWith('loopModelByProvider', {});
  });

  it('falls back to the session default for providers with no entry', () => {
    fixture.detectChanges();

    expect(selectFor('claude').value).toBe('');
  });
});
