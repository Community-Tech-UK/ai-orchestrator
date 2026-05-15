import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelectionPanelComponent } from './model-selection-panel.component';
import type { ModelDisplayInfo, ReasoningEffort } from '../../../../shared/types/provider.types';
import type { PickerProvider } from './compact-model-picker.types';
import type { UnifiedReasoningOption, UnifiedSelection } from './unified-model-menu.component';

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'Copilot',
  cursor: 'Cursor',
};

const CLAUDE_MODELS: ModelDisplayInfo[] = [
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', tier: 'powerful', pinned: true, family: 'Opus' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'balanced', family: 'Sonnet' },
];

const CODEX_MODELS: ModelDisplayInfo[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', tier: 'powerful', pinned: true, family: 'GPT' },
  { id: 'gpt-5.5-mini', name: 'GPT-5.5 Mini', tier: 'fast', family: 'GPT' },
];

const GEMINI_MODELS: ModelDisplayInfo[] = [
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', tier: 'powerful', pinned: true, family: 'Gemini' },
];

const REASONING_OPTIONS: UnifiedReasoningOption[] = [
  { id: 'default', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

describe('ModelSelectionPanelComponent', () => {
  let fixture: ComponentFixture<ModelSelectionPanelComponent>;

  beforeEach(() => {
    window.localStorage.clear();
    TestBed.configureTestingModule({ imports: [ModelSelectionPanelComponent] });
    fixture = TestBed.createComponent(ModelSelectionPanelComponent);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setInputs(overrides: {
    providers?: PickerProvider[];
    selectedProvider?: PickerProvider | null;
    selectedModelId?: string | null;
    selectedReasoning?: ReasoningEffort | null;
    reasoningOptionsForProvider?: (provider: PickerProvider) => UnifiedReasoningOption[];
    disabledReasonForProvider?: (provider: PickerProvider) => string | undefined;
  } = {}): void {
    fixture.componentRef.setInput('providers', overrides.providers ?? ['claude', 'codex']);
    fixture.componentRef.setInput('selectedProvider', overrides.selectedProvider ?? 'claude');
    fixture.componentRef.setInput('selectedModelId', overrides.selectedModelId ?? 'claude-opus-4-7');
    fixture.componentRef.setInput('selectedReasoning', overrides.selectedReasoning ?? null);
    fixture.componentRef.setInput('providerLabels', PROVIDER_LABELS);
    fixture.componentRef.setInput('modelsForProvider', (provider: PickerProvider) => {
      if (provider === 'claude') return CLAUDE_MODELS;
      if (provider === 'codex') return CODEX_MODELS;
      if (provider === 'gemini') return GEMINI_MODELS;
      return [];
    });
    fixture.componentRef.setInput('reasoningOptionsForProvider', overrides.reasoningOptionsForProvider ?? (() => []));
    fixture.componentRef.setInput('disabledReasonForProvider', overrides.disabledReasonForProvider ?? (() => undefined));
    fixture.detectChanges();
  }

  function rowNames(): string[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.model-picker-row__name'))
      .map((el) => (el as HTMLElement).textContent?.trim() ?? '');
  }

  it('opens on favorites seeded from each visible provider primary model', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    setInputs();

    const activeRail = fixture.nativeElement.querySelector('.model-picker-rail__button.active') as HTMLElement;
    expect(activeRail.getAttribute('data-tab')).toBe('favorites');
    expect(rowNames()).toEqual(['Claude Opus 4.7', 'GPT-5.5']);

    const providers = Array.from(fixture.nativeElement.querySelectorAll('.model-picker-row__provider'))
      .map((el) => (el as HTMLElement).textContent?.trim());
    expect(providers).toEqual(['Claude', 'Codex']);

    const shortcuts = Array.from(fixture.nativeElement.querySelectorAll('.model-picker-row__shortcut'))
      .map((el) => (el as HTMLElement).textContent?.trim());
    expect(shortcuts).toEqual(['⌘1', '⌘2']);
  });

  it('uses Ctrl shortcut labels away from Apple platforms', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    setInputs();

    const shortcuts = Array.from(fixture.nativeElement.querySelectorAll('.model-picker-row__shortcut'))
      .map((el) => (el as HTMLElement).textContent?.trim());

    expect(shortcuts).toEqual(['Ctrl 1', 'Ctrl 2']);
  });

  it('filters models inside a provider tab with the search box', () => {
    setInputs();

    const codexTab = fixture.nativeElement.querySelector('[data-provider="codex"]') as HTMLButtonElement;
    codexTab.click();
    fixture.detectChanges();

    const search = fixture.nativeElement.querySelector('.model-picker-search__input') as HTMLInputElement;
    search.value = 'mini';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(rowNames()).toEqual(['GPT-5.5 Mini']);
  });

  it('toggles a model into favorites and persists the customized favorite set', () => {
    setInputs();

    (fixture.nativeElement.querySelector('[data-provider="codex"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const miniFavorite = Array.from(fixture.nativeElement.querySelectorAll('.model-picker-row'))
      .find((el) => (el as HTMLElement).textContent?.includes('GPT-5.5 Mini'))!
      .querySelector('.model-picker-row__favorite') as HTMLButtonElement;
    miniFavorite.click();
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('[data-tab="favorites"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(rowNames()).toContain('GPT-5.5 Mini');
    expect(window.localStorage.getItem('compact-model-picker:favorites:v1')).toContain('codex:gpt-5.5-mini');
  });

  it('favorite keyboard interaction toggles the star without selecting the model row', () => {
    setInputs();

    const emitted: UnifiedSelection[] = [];
    fixture.componentInstance.selection.subscribe((selection) => emitted.push(selection));

    (fixture.nativeElement.querySelector('[data-provider="codex"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const miniFavorite = Array.from(fixture.nativeElement.querySelectorAll('.model-picker-row'))
      .find((el) => (el as HTMLElement).textContent?.includes('GPT-5.5 Mini'))!
      .querySelector('.model-picker-row__favorite') as HTMLButtonElement;
    miniFavorite.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(window.localStorage.getItem('compact-model-picker:favorites:v1')).toContain('codex:gpt-5.5-mini');
  });

  it('emits a reasoning selection from the rendered reasoning control', () => {
    setInputs({
      selectedReasoning: 'medium',
      reasoningOptionsForProvider: (provider) => provider === 'claude' ? REASONING_OPTIONS : [],
    });

    const emitted: UnifiedSelection[] = [];
    fixture.componentInstance.selection.subscribe((selection) => emitted.push(selection));

    const select = fixture.nativeElement.querySelector('.model-picker-row__reasoning') as HTMLSelectElement;
    expect(select.value).toBe('medium');

    select.value = 'high';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([
      {
        kind: 'reasoning',
        provider: 'claude',
        modelId: 'claude-opus-4-7',
        level: 'high',
      },
    ]);
  });

  it('emits model selections from rows and keyboard shortcuts while respecting disabled providers', () => {
    setInputs({
      disabledReasonForProvider: (provider) =>
        provider === 'codex' ? 'Provider can only be changed before the first message' : undefined,
    });

    const emitted: UnifiedSelection[] = [];
    fixture.componentInstance.selection.subscribe((selection) => emitted.push(selection));

    const codexRow = Array.from(fixture.nativeElement.querySelectorAll('.model-picker-row'))
      .find((el) => (el as HTMLElement).textContent?.includes('GPT-5.5')) as HTMLElement;
    (codexRow.querySelector('.model-picker-row__select') as HTMLButtonElement).click();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('.model-picker-panel') as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true }));
    fixture.detectChanges();
    expect(emitted).toEqual([]);
    expect(codexRow.getAttribute('aria-disabled')).toBe('true');

    const claudeRow = Array.from(fixture.nativeElement.querySelectorAll('.model-picker-row'))
      .find((el) => (el as HTMLElement).textContent?.includes('Claude Opus 4.7')) as HTMLElement;
    (claudeRow.querySelector('.model-picker-row__select') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(emitted).toEqual([
      { kind: 'model', provider: 'claude', modelId: 'claude-opus-4-7' },
    ]);
  });
});
