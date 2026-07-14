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
    TestBed.overrideComponent(OrchestrationSettingsTabComponent, {
      set: {
        imports: [SettingRowComponent, CompactModelPickerStubComponent],
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

  function pickerFor(provider: string): CompactModelPickerStubComponent {
    const picker = fixture.debugElement
      .queryAll(By.directive(CompactModelPickerStubComponent))
      .map((debugElement) => debugElement.componentInstance as CompactModelPickerStubComponent)
      .find((candidate) => candidate.providers?.[0] === provider);
    if (!picker) throw new Error(`No loop model picker for ${provider}`);
    return picker;
  }
});
