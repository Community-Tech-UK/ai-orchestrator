import {
  Component,
  EventEmitter,
  Input,
  Output,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from '../../../../shared/types/settings.types';
import type { SettingMetadata } from '../../../../shared/types/settings.types';
import { getPrimaryModelForProvider } from '../../../../shared/types/provider.types';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';
import { SettingsStore } from '../../core/state/settings.store';
import { GeneralSettingsTabComponent } from './general-settings-tab.component';

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

@Component({ selector: 'app-compact-model-picker', standalone: true, template: '' })
class CompactModelPickerStubComponent {
  @Input() mode: unknown;
  @Input() providers: PickerProvider[] | null = null;
  @Input() selection: PendingSelection | null = null;
  @Output() selectionChange = new EventEmitter<PendingSelection>();
}

@Component({ selector: 'app-update-settings', standalone: true, template: '' })
class AppUpdateSettingsStubComponent {}

@Component({
  selector: 'app-setting-row',
  standalone: true,
  template: '<span [attr.data-setting-key]="setting?.key"></span>',
})
class SettingRowStubComponent {
  @Input() setting: SettingMetadata | null = null;
  @Input() value: unknown;
  @Output() valueChange = new EventEmitter<{ key: string; value: unknown }>();
}

class FakeSettingsStore {
  readonly settings = signal({
    ...DEFAULT_SETTINGS,
    defaultCli: 'claude' as const,
    defaultModel: 'opus',
    defaultModelByProvider: { claude: 'opus' },
  });
  readonly generalSettings = signal(
    SETTINGS_METADATA.filter((setting) => setting.category === 'general' && !setting.hidden),
  );
  readonly update = vi.fn(async (patch: Record<string, unknown>) => {
    this.settings.update((current) => ({ ...current, ...patch }));
  });
  readonly set = vi.fn();

  get(key: keyof typeof DEFAULT_SETTINGS): unknown {
    return this.settings()[key];
  }
}

describe('GeneralSettingsTabComponent model defaults', () => {
  let fixture: ComponentFixture<GeneralSettingsTabComponent>;
  let store: FakeSettingsStore;

  beforeEach(async () => {
    store = new FakeSettingsStore();
    TestBed.configureTestingModule({
      imports: [GeneralSettingsTabComponent],
      providers: [{ provide: SettingsStore, useValue: store }],
    });
    TestBed.overrideComponent(GeneralSettingsTabComponent, {
      set: {
        imports: [
          SettingRowStubComponent,
          CompactModelPickerStubComponent,
          AppUpdateSettingsStubComponent,
        ],
        styles: [''],
        styleUrl: undefined,
        styleUrls: [],
      },
    });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(GeneralSettingsTabComponent);
  });

  it('uses the shared session picker for the default provider and model', () => {
    fixture.detectChanges();

    const picker = modelPicker();
    expect(picker.providers).toEqual([
      'claude',
      'codex',
      'gemini',
      'antigravity',
      'copilot',
      'cursor',
      'grok',
    ]);
    expect(picker.selection).toEqual({ provider: 'claude', model: 'opus', reasoning: null });
    expect(fixture.nativeElement.querySelector('[data-setting-key="defaultModel"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-setting-key="defaultCli"]')).toBeNull();
  });

  it('persists provider and per-provider model memory from the shared picker', () => {
    fixture.detectChanges();

    modelPicker().selectionChange.emit({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
    });

    expect(store.update).toHaveBeenCalledWith({
      defaultCli: 'codex',
      defaultModel: 'gpt-5.6-sol',
      defaultModelByProvider: {
        claude: 'opus',
        codex: 'gpt-5.6-sol',
      },
    });
  });

  it('supports automatic routing without discarding remembered models', () => {
    fixture.detectChanges();

    const autoButton = fixture.nativeElement.querySelector(
      'button[aria-label="Automatically choose the default provider"]',
    ) as HTMLButtonElement;
    autoButton.click();

    expect(store.update).toHaveBeenCalledWith({ defaultCli: 'auto' });
    expect(store.settings().defaultModelByProvider).toEqual({ claude: 'opus' });
  });

  function modelPicker(): CompactModelPickerStubComponent {
    const debugElement = fixture.debugElement.query(By.directive(CompactModelPickerStubComponent));
    if (!debugElement) throw new Error('No default model picker');
    return debugElement.componentInstance as CompactModelPickerStubComponent;
  }
});

describe('GeneralSettingsTabComponent automation model default', () => {
  let fixture: ComponentFixture<GeneralSettingsTabComponent>;
  let store: FakeSettingsStore;

  beforeEach(async () => {
    store = new FakeSettingsStore();
    TestBed.configureTestingModule({
      imports: [GeneralSettingsTabComponent],
      providers: [{ provide: SettingsStore, useValue: store }],
    });
    TestBed.overrideComponent(GeneralSettingsTabComponent, {
      set: {
        imports: [
          SettingRowStubComponent,
          CompactModelPickerStubComponent,
          AppUpdateSettingsStubComponent,
        ],
        styles: [''],
        styleUrl: undefined,
        styleUrls: [],
      },
    });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(GeneralSettingsTabComponent);
  });

  it('pins the dedicated automation keys without touching defaultModelByProvider', () => {
    fixture.detectChanges();

    const pinButton = fixture.nativeElement.querySelector(
      'button[aria-label="Pin the default automation provider and model"]',
    ) as HTMLButtonElement;
    pinButton.click();

    expect(store.update).toHaveBeenCalledWith({
      automationDefaultCli: 'claude',
      automationDefaultModel: getPrimaryModelForProvider('claude'),
    });
    // The interactive per-provider memory must be left untouched.
    expect(store.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ defaultModelByProvider: expect.anything() }),
    );
  });

  it('persists picker changes only to the dedicated automation keys', () => {
    store.settings.update((current) => ({
      ...current,
      automationDefaultCli: 'claude',
      automationDefaultModel: 'opus[1m]',
    }));
    fixture.detectChanges();

    automationPicker().selectionChange.emit({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
    });

    expect(store.update).toHaveBeenCalledWith({
      automationDefaultCli: 'codex',
      automationDefaultModel: 'gpt-5.6-sol',
    });
  });

  it('clears both dedicated keys when set back to Auto', () => {
    store.settings.update((current) => ({
      ...current,
      automationDefaultCli: 'claude',
      automationDefaultModel: 'opus[1m]',
    }));
    fixture.detectChanges();

    const autoButton = fixture.nativeElement.querySelector(
      'button[aria-label="Let each automation fall back to the provider default"]',
    ) as HTMLButtonElement;
    autoButton.click();

    expect(store.update).toHaveBeenCalledWith({
      automationDefaultCli: 'auto',
      automationDefaultModel: '',
    });
  });

  /** The automation picker is the second one in the template (after the session default). */
  function automationPicker(): CompactModelPickerStubComponent {
    const pickers = fixture.debugElement.queryAll(By.directive(CompactModelPickerStubComponent));
    const picker = pickers[pickers.length - 1];
    if (!picker) throw new Error('No automation model picker');
    return picker.componentInstance as CompactModelPickerStubComponent;
  }
});
