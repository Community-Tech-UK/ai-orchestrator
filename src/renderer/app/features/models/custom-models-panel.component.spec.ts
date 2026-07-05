import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, ViewChild } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomModelsPanelComponent } from './custom-models-panel.component';
import { SettingsIpcService } from '../../core/services/ipc/settings-ipc.service';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings.types';

@Component({
  standalone: true,
  imports: [CustomModelsPanelComponent],
  template: `
    <app-custom-models-panel
      [provider]="provider"
      [availableModelIds]="availableModelIds"
    />
  `,
})
class CustomModelsPanelHostComponent {
  provider = 'claude';
  availableModelIds: string[] = ['sonnet'];

  @ViewChild(CustomModelsPanelComponent)
  panel!: CustomModelsPanelComponent;
}

describe('CustomModelsPanelComponent', () => {
  let fixture: ComponentFixture<CustomModelsPanelHostComponent>;
  let host: CustomModelsPanelHostComponent;
  let component: CustomModelsPanelComponent;
  let settings: AppSettings;
  let settingsIpc: {
    getSettings: ReturnType<typeof vi.fn>;
    setSetting: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    settings = {
      ...DEFAULT_SETTINGS,
      customModelsByProvider: {
        claude: ['claude-future-opus'],
      },
    };
    settingsIpc = {
      getSettings: vi.fn(async () => ({ success: true, data: settings })),
      setSetting: vi.fn(async (_key: keyof AppSettings, value: unknown) => {
        settings = {
          ...settings,
          customModelsByProvider: value as Record<string, string[]>,
        };
        return { success: true };
      }),
    };

    await TestBed.configureTestingModule({
      imports: [CustomModelsPanelHostComponent],
      providers: [
        { provide: SettingsIpcService, useValue: settingsIpc },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CustomModelsPanelHostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    component = host.panel;
  });

  it('loads and displays custom models for the active provider', () => {
    expect(component.customModelsForProvider()).toEqual(['claude-future-opus']);
    expect(fixture.nativeElement.textContent).toContain('claude-future-opus');
  });

  it('rejects empty custom model ids before persisting', async () => {
    component.onCustomModelInput({ target: { value: '   ' } } as unknown as Event);

    await component.addCustomModel();

    expect(settingsIpc.setSetting).not.toHaveBeenCalled();
    expect(component.error()).toBe('Enter a model id.');
  });

  it('rejects duplicates for the active provider before persisting', async () => {
    component.onCustomModelInput({ target: { value: 'claude-future-opus' } } as unknown as Event);

    await component.addCustomModel();

    expect(settingsIpc.setSetting).not.toHaveBeenCalled();
    expect(component.error()).toBe('That model is already in this provider list.');
  });

  it('rejects ids already available in the provider catalog before persisting', async () => {
    expect(component.availableModelIdsValue()).toEqual(['sonnet']);
    component.onCustomModelInput({ target: { value: 'sonnet' } } as unknown as Event);

    await component.addCustomModel();

    expect(settingsIpc.setSetting).not.toHaveBeenCalled();
    expect(component.error()).toBe('That model is already available for this provider.');
  });

  it('rejects custom model ids beyond the dynamic catalog limit before persisting', async () => {
    const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;
    expect(tooLongCatalogModelId).toHaveLength(513);
    component.onCustomModelInput({ target: { value: tooLongCatalogModelId } } as unknown as Event);

    await component.addCustomModel();

    expect(settingsIpc.setSetting).not.toHaveBeenCalled();
    expect(component.error()).toBe('Model id must be 512 characters or fewer.');
  });

  it('persists added and removed custom model ids per provider', async () => {
    component.onCustomModelInput({ target: { value: 'claude-new-haiku' } } as unknown as Event);

    await component.addCustomModel();

    expect(settingsIpc.setSetting).toHaveBeenLastCalledWith('customModelsByProvider', {
      claude: ['claude-future-opus', 'claude-new-haiku'],
    });
    expect(component.customModelsForProvider()).toEqual([
      'claude-future-opus',
      'claude-new-haiku',
    ]);

    await component.removeCustomModel('claude-future-opus');

    expect(settingsIpc.setSetting).toHaveBeenLastCalledWith('customModelsByProvider', {
      claude: ['claude-new-haiku'],
    });
    expect(component.customModelsForProvider()).toEqual(['claude-new-haiku']);
  });

  it('shows an error when saving custom models throws', async () => {
    settingsIpc.setSetting.mockRejectedValueOnce(new Error('settings offline'));
    component.onCustomModelInput({ target: { value: 'claude-new-haiku' } } as unknown as Event);

    await component.addCustomModel();

    expect(component.error()).toBe('settings offline');
    expect(component.saving()).toBe(false);
    expect(component.customModelsForProvider()).toEqual(['claude-future-opus']);
  });

  it('shows an error when loading custom model settings throws', async () => {
    settingsIpc.getSettings.mockRejectedValueOnce(new Error('settings unavailable'));

    await component.ngOnInit();

    expect(component.error()).toBe('settings unavailable');
    expect(component.customModelsForProvider()).toEqual(['claude-future-opus']);
  });
});
