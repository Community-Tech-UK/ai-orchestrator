import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';
import type { PickerProvider } from './compact-model-picker.types';
import { ModelSelectionPanelComponent } from './model-selection-panel.component';
import type { UnifiedReasoningOption, UnifiedSelection } from './model-selection.types';
import { ModelUsageMemoryService } from './model-usage-memory.service';

const MODELS: ModelDisplayInfo[] = [
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', tier: 'powerful', pinned: true, family: 'Opus' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'balanced', family: 'Sonnet' },
];
const EFFORTS: UnifiedReasoningOption[] = [
  { id: 'default', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'high', label: 'High' },
];

describe('ModelSelectionPanelComponent: what a choice costs, shown before the click', () => {
  let fixture: ComponentFixture<ModelSelectionPanelComponent>;
  const previews: (UnifiedSelection | null)[] = [];

  beforeEach(() => {
    window.localStorage.clear();
    previews.length = 0;
    TestBed.configureTestingModule({
      imports: [ModelSelectionPanelComponent],
      providers: [{
        provide: ModelUsageMemoryService,
        useValue: { usageByKey: signal({}).asReadonly(), record: vi.fn(), score: vi.fn(), compareKeys: vi.fn() },
      }],
    });
    fixture = TestBed.createComponent(ModelSelectionPanelComponent);
    fixture.componentRef.setInput('providers', ['claude'] as PickerProvider[]);
    fixture.componentRef.setInput('selectedProvider', 'claude');
    fixture.componentRef.setInput('selectedModelId', 'claude-opus-4-7');
    fixture.componentRef.setInput('selectedReasoning', null);
    fixture.componentRef.setInput('providerLabels', { claude: 'Claude' });
    fixture.componentRef.setInput('modelsForProvider', () => MODELS);
    fixture.componentRef.setInput('reasoningOptionsForProvider', () => EFFORTS);
    fixture.componentRef.setInput('disabledReasonForProvider', () => undefined);
    fixture.componentInstance.rowPreview.subscribe((selection) => previews.push(selection));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('[data-provider="claude"]') as HTMLButtonElement).click();
    fixture.detectChanges();
  });

  const rows = (): HTMLElement[] => Array.from(fixture.nativeElement.querySelectorAll('.model-picker-row'));
  const note = (): string | null => (fixture.nativeElement.querySelector('[data-testid="model-picker-cost-note"]') as HTMLElement | null)?.textContent?.trim() ?? null;

  it('reports the option under the pointer, and when the pointer leaves', () => {
    const second = rows().find((row) => row.textContent?.includes('Sonnet'))!;
    second.dispatchEvent(new MouseEvent('mouseenter'));
    second.dispatchEvent(new MouseEvent('mouseleave'));
    expect(previews).toEqual([{ kind: 'model', provider: 'claude', modelId: 'claude-sonnet-4-6' }, null]);
  });

  it('reports the same option for keyboard focus', () => {
    const first = rows()[0]!;
    first.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(previews[0]).toMatchObject({ kind: 'model', provider: 'claude' });
  });

  it('stands in another effort for "change the effort" when the effort list takes focus', () => {
    const select = fixture.nativeElement.querySelector('select.model-picker-row__reasoning') as HTMLSelectElement;
    select.dispatchEvent(new FocusEvent('focus'));
    expect(previews.at(-1)).toEqual({ kind: 'reasoning', provider: 'claude', modelId: 'claude-opus-4-7', level: 'low' });
  });

  it('shows the sentence the host gives it, and nothing when there is none', () => {
    expect(note()).toBeNull();
    fixture.componentRef.setInput('optionNote', 'Switching model starts a new session with a short summary.');
    fixture.detectChanges();
    expect(note()).toBe('Switching model starts a new session with a short summary.');
    fixture.componentRef.setInput('optionNote', null);
    fixture.detectChanges();
    expect(note()).toBeNull();
  });
});
