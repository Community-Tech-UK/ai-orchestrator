import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactModelPickerComponent } from './compact-model-picker.component';
import { InstanceStore } from '../../core/state/instance.store';
import { ChatStore } from '../../core/state/chat.store';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { UsageStore } from '../../core/state/usage.store';
import { getModelsForProvider } from '../../../../shared/types/provider.types';
import { DynamicModelCatalogService } from './dynamic-model-catalog.service';
import { UnifiedCatalogStore } from './unified-catalog.store';
import type { PickerProvider } from './compact-model-picker.types';

/**
 * Plan 12a item 4: the picker passes its `switchNote` / `switchNoteForProvider`
 * inputs on to the selection panel (`[note]`, `[noteForProvider]`), which
 * draws them as visible text. These render the real picker and panel and read
 * what a person would read, so dropping either binding fails here.
 */
describe('CompactModelPickerComponent switch note', () => {
  let fixture: ComponentFixture<CompactModelPickerComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [CompactModelPickerComponent],
      providers: [
        { provide: InstanceStore, useValue: { selectedInstance: signal(null), changeModel: vi.fn(), changeAgentMode: vi.fn() } },
        { provide: ChatStore, useValue: { setProvider: vi.fn(), setModel: vi.fn(), setReasoning: vi.fn() } },
        { provide: ProviderStateService, useValue: { selectedProvider: signal('claude') } },
        { provide: UsageStore, useValue: { record: vi.fn() } },
        { provide: DynamicModelCatalogService, useValue: { ensureLoaded: vi.fn(), modelsFor: vi.fn((p: string) => getModelsForProvider(p)) } },
        { provide: UnifiedCatalogStore, useValue: {
          ensureLoaded: vi.fn(),
          displayModelsForProvider: vi.fn(() => []),
          lastBuiltAt: signal<number | null>(null),
        } },
      ],
    });
    fixture = TestBed.createComponent(CompactModelPickerComponent);
    fixture.componentRef.setInput('mode', 'pending-create');
    fixture.componentRef.setInput('selection', { provider: 'claude', model: 'sonnet', reasoning: null });
  });

  afterEach(() => {
    fixture.destroy();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => { el.innerHTML = ''; });
  });

  function open(): void {
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.compact-picker__chip') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(document.querySelector('app-model-selection-panel'), 'the menu opened').not.toBeNull();
  }
  const noteText = () => document.querySelector('.model-picker-note[role="note"]')?.textContent?.trim() ?? null;

  it('draws no note when neither input is set', () => {
    open();
    expect(noteText()).toBeNull();
  });

  it('passes the fixed switchNote to the panel as visible text', () => {
    fixture.componentRef.setInput('switchNote', 'Switches in place. Example fixed note.');
    open();
    expect(noteText()).toBe('Switches in place. Example fixed note.');
  });

  it('passes switchNoteForProvider to the panel, asked for the provider on the active tab', () => {
    const forProvider = vi.fn((provider: PickerProvider) => `Note for ${provider}`);
    fixture.componentRef.setInput('switchNoteForProvider', forProvider);
    open();
    expect(forProvider).toHaveBeenCalledWith('claude');
    expect(noteText()).toBe('Note for claude');
  });

  it('prefers the per-provider note over the fixed one, and falls back to the fixed one when it returns null', () => {
    fixture.componentRef.setInput('switchNote', 'Fixed note');
    fixture.componentRef.setInput('switchNoteForProvider', (provider: PickerProvider) => (provider === 'claude' ? 'Per-provider note' : null));
    open();
    expect(noteText()).toBe('Per-provider note');

    fixture.componentRef.setInput('switchNoteForProvider', () => null);
    fixture.detectChanges();
    expect(noteText()).toBe('Fixed note');
  });
});
