import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  UnifiedModelMenuComponent,
  type UnifiedReasoningOption,
  type UnifiedSelection,
} from './unified-model-menu.component';
import type {
  ModelDisplayInfo,
  ReasoningEffort,
} from '../../../../shared/types/provider.types';
import type { PickerProvider } from './compact-model-picker.types';

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'Copilot',
  cursor: 'Cursor',
};

const REASONING_OPTIONS: UnifiedReasoningOption[] = [
  { id: 'default', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

const CLAUDE_MODELS: ModelDisplayInfo[] = [
  { id: 'opus', name: 'Opus latest', tier: 'powerful', pinned: true, family: 'Opus' },
  { id: 'sonnet', name: 'Sonnet latest', tier: 'balanced', pinned: true, family: 'Sonnet' },
  { id: 'opus-4-7', name: 'Opus 4.7', tier: 'powerful', family: 'Opus' },
  { id: 'opus-4-6', name: 'Opus 4.6', tier: 'powerful', family: 'Opus' },
];

const CODEX_MODELS: ModelDisplayInfo[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', tier: 'powerful', pinned: true, family: 'GPT' },
  { id: 'gpt-5.2', name: 'GPT-5.2', tier: 'balanced', family: 'GPT' },
];

const GEMINI_MODELS: ModelDisplayInfo[] = [
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', tier: 'powerful', pinned: true, family: 'Pro' },
];

describe('UnifiedModelMenuComponent', () => {
  let fixture: ComponentFixture<UnifiedModelMenuComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UnifiedModelMenuComponent] });
    fixture = TestBed.createComponent(UnifiedModelMenuComponent);
  });

  function setInputs(overrides: {
    providers?: PickerProvider[];
    selectedProvider?: PickerProvider | null;
    selectedModelId?: string | null;
    selectedReasoning?: ReasoningEffort | null;
    providerLabels?: Record<string, string>;
    modelsForProvider?: (provider: PickerProvider) => ModelDisplayInfo[];
    reasoningOptionsForProvider?: (provider: PickerProvider) => UnifiedReasoningOption[];
    disabledReasonForProvider?: (provider: PickerProvider) => string | undefined;
  }): void {
    if (overrides.providers !== undefined) {
      fixture.componentRef.setInput('providers', overrides.providers);
    }
    if (overrides.selectedProvider !== undefined) {
      fixture.componentRef.setInput('selectedProvider', overrides.selectedProvider);
    }
    if (overrides.selectedModelId !== undefined) {
      fixture.componentRef.setInput('selectedModelId', overrides.selectedModelId);
    }
    if (overrides.selectedReasoning !== undefined) {
      fixture.componentRef.setInput('selectedReasoning', overrides.selectedReasoning);
    }
    if (overrides.providerLabels !== undefined) {
      fixture.componentRef.setInput('providerLabels', overrides.providerLabels);
    }
    if (overrides.modelsForProvider !== undefined) {
      fixture.componentRef.setInput('modelsForProvider', overrides.modelsForProvider);
    }
    if (overrides.reasoningOptionsForProvider !== undefined) {
      fixture.componentRef.setInput(
        'reasoningOptionsForProvider',
        overrides.reasoningOptionsForProvider,
      );
    }
    if (overrides.disabledReasonForProvider !== undefined) {
      fixture.componentRef.setInput(
        'disabledReasonForProvider',
        overrides.disabledReasonForProvider,
      );
    }
    fixture.detectChanges();
  }

  function defaultSetup(): void {
    setInputs({
      providers: ['claude', 'codex', 'gemini'],
      selectedProvider: 'claude',
      selectedModelId: 'sonnet',
      selectedReasoning: null,
      providerLabels: PROVIDER_LABELS,
      modelsForProvider: (p) => {
        if (p === 'claude') return CLAUDE_MODELS;
        if (p === 'codex') return CODEX_MODELS;
        if (p === 'gemini') return GEMINI_MODELS;
        return [];
      },
      reasoningOptionsForProvider: (p) => {
        if (p === 'claude' || p === 'codex') return REASONING_OPTIONS;
        return [];
      },
    });
  }

  it('renders one top-level row per provider in the given order', () => {
    defaultSetup();
    const labels = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-row__label'))
      .map((el) => (el as HTMLElement).textContent?.trim());
    expect(labels).toEqual(['Claude', 'Codex', 'Gemini']);
  });

  it('marks the currently-selected provider with aria-checked="true"', () => {
    defaultSetup();
    const rows = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-row__body')) as HTMLElement[];
    const claudeRow = rows.find((r) => r.textContent?.includes('Claude'))!;
    const codexRow = rows.find((r) => r.textContent?.includes('Codex'))!;
    expect(claudeRow.getAttribute('aria-checked')).toBe('true');
    expect(codexRow.getAttribute('aria-checked')).toBeNull();
  });

  it('renders an empty-state when no providers are passed', () => {
    setInputs({
      providers: [],
      selectedProvider: null,
      selectedModelId: null,
      selectedReasoning: null,
      providerLabels: PROVIDER_LABELS,
      modelsForProvider: () => [],
      reasoningOptionsForProvider: () => [],
    });
    expect(fixture.nativeElement.querySelector('.nested-menu__empty')?.textContent).toContain(
      'No providers available',
    );
  });

  it('exposes a submenu for every provider with the provider\'s pinned models in the Latest section', () => {
    defaultSetup();
    const claudeProviderItem = fixture.componentInstance
      .menuModel()
      .sections[0].items.find((i) => i.id === 'provider:claude')!;
    expect(claudeProviderItem.submenu).toBeDefined();

    const latestSection = claudeProviderItem.submenu!.sections.find((s) =>
      s.id.startsWith('latest:'),
    )!;
    expect(latestSection.items.map((i) => i.label)).toEqual(['Opus latest', 'Sonnet latest']);
  });

  it('groups non-pinned models inside an "Other versions" submenu by family', () => {
    defaultSetup();
    const claudeProviderItem = fixture.componentInstance
      .menuModel()
      .sections[0].items.find((i) => i.id === 'provider:claude')!;
    const otherWrap = claudeProviderItem.submenu!.sections.find((s) =>
      s.id.startsWith('other-versions-wrap:'),
    )!;
    const otherVersionsItem = otherWrap.items[0];
    expect(otherVersionsItem.label).toBe('Other versions');

    const familySections = otherVersionsItem.submenu!.sections;
    expect(familySections.length).toBe(1);
    expect(familySections[0].label).toBe('Opus');
    // version-descending: 4.7 before 4.6
    expect(familySections[0].items.map((i) => i.label)).toEqual(['Opus 4.7', 'Opus 4.6']);
  });

  it('attaches an Intelligence submenu only when the provider has reasoning options', () => {
    defaultSetup();
    const claudeProviderItem = fixture.componentInstance
      .menuModel()
      .sections[0].items.find((i) => i.id === 'provider:claude')!;
    const claudeOpusItem = claudeProviderItem
      .submenu!.sections.find((s) => s.id.startsWith('latest:'))!
      .items[0];
    expect(claudeOpusItem.submenu?.sections[0].label).toBe('Intelligence');

    const geminiProviderItem = fixture.componentInstance
      .menuModel()
      .sections[0].items.find((i) => i.id === 'provider:gemini')!;
    const geminiProItem = geminiProviderItem
      .submenu!.sections.find((s) => s.id.startsWith('latest:'))!
      .items[0];
    expect(geminiProItem.submenu).toBeUndefined();
  });

  it('marks the current provider+model+reasoning leaf as selected', () => {
    setInputs({
      providers: ['claude', 'codex'],
      selectedProvider: 'claude',
      selectedModelId: 'opus',
      selectedReasoning: 'high',
      providerLabels: PROVIDER_LABELS,
      modelsForProvider: (p) => (p === 'claude' ? CLAUDE_MODELS : CODEX_MODELS),
      reasoningOptionsForProvider: () => REASONING_OPTIONS,
    });

    const claude = fixture.componentInstance
      .menuModel()
      .sections[0].items.find((i) => i.id === 'provider:claude')!;
    const opus = claude
      .submenu!.sections.find((s) => s.id.startsWith('latest:'))!
      .items[0];
    expect(opus.selected).toBe(true);
    const high = opus.submenu!.sections[0].items.find((i) => i.label === 'High')!;
    expect(high.selected).toBe(true);
    const def = opus.submenu!.sections[0].items.find((i) => i.label === 'Default')!;
    expect(def.selected).toBe(false);
  });

  it('Default reasoning leaf is selected when selectedReasoning is null on the current model', () => {
    setInputs({
      providers: ['claude'],
      selectedProvider: 'claude',
      selectedModelId: 'sonnet',
      selectedReasoning: null,
      providerLabels: PROVIDER_LABELS,
      modelsForProvider: () => CLAUDE_MODELS,
      reasoningOptionsForProvider: () => REASONING_OPTIONS,
    });
    const claude = fixture.componentInstance.menuModel().sections[0].items[0];
    const sonnet = claude
      .submenu!.sections.find((s) => s.id.startsWith('latest:'))!
      .items.find((i) => i.label === 'Sonnet latest')!;
    const def = sonnet.submenu!.sections[0].items.find((i) => i.label === 'Default')!;
    expect(def.selected).toBe(true);
  });

  it('emits a "provider" selection when a provider row is clicked directly', () => {
    defaultSetup();
    let emitted: UnifiedSelection | null = null;
    fixture.componentInstance.selection.subscribe((s) => (emitted = s));

    const codexProviderItem = fixture.componentInstance
      .menuModel()
      .sections[0].items.find((i) => i.id === 'provider:codex')!;
    fixture.componentInstance.onSelect(codexProviderItem);

    expect(emitted).toEqual({ kind: 'provider', provider: 'codex' });
  });

  it('emits a "model" selection when a model leaf is selected', () => {
    defaultSetup();
    let emitted: UnifiedSelection | null = null;
    fixture.componentInstance.selection.subscribe((s) => (emitted = s));

    const codexProviderItem = fixture.componentInstance
      .menuModel()
      .sections[0].items.find((i) => i.id === 'provider:codex')!;
    const gpt55 = codexProviderItem
      .submenu!.sections.find((s) => s.id.startsWith('latest:'))!
      .items[0];
    fixture.componentInstance.onSelect(gpt55);

    expect(emitted).toEqual({ kind: 'model', provider: 'codex', modelId: 'gpt-5.5' });
  });

  it('emits a "reasoning" selection when an Intelligence leaf is chosen', () => {
    defaultSetup();
    let emitted: UnifiedSelection | null = null;
    fixture.componentInstance.selection.subscribe((s) => (emitted = s));

    const claudeProvider = fixture.componentInstance
      .menuModel()
      .sections[0].items.find((i) => i.id === 'provider:claude')!;
    const opus = claudeProvider
      .submenu!.sections.find((s) => s.id.startsWith('latest:'))!
      .items[0];
    const high = opus.submenu!.sections[0].items.find((i) => i.label === 'High')!;
    fixture.componentInstance.onSelect(high);

    expect(emitted).toEqual({
      kind: 'reasoning',
      provider: 'claude',
      modelId: 'opus',
      level: 'high',
    });
  });

  it('Default reasoning leaf emits null level', () => {
    defaultSetup();
    let emitted: UnifiedSelection | null = null;
    fixture.componentInstance.selection.subscribe((s) => (emitted = s));

    const claudeProvider = fixture.componentInstance
      .menuModel()
      .sections[0].items.find((i) => i.id === 'provider:claude')!;
    const opus = claudeProvider
      .submenu!.sections.find((s) => s.id.startsWith('latest:'))!
      .items[0];
    const def = opus.submenu!.sections[0].items.find((i) => i.label === 'Default')!;
    fixture.componentInstance.onSelect(def);

    expect(emitted).toEqual({
      kind: 'reasoning',
      provider: 'claude',
      modelId: 'opus',
      level: null,
    });
  });

  it('disables a provider row using disabledReasonForProvider', () => {
    setInputs({
      providers: ['claude', 'codex'],
      selectedProvider: 'claude',
      selectedModelId: 'sonnet',
      selectedReasoning: null,
      providerLabels: PROVIDER_LABELS,
      modelsForProvider: (p) => (p === 'claude' ? CLAUDE_MODELS : CODEX_MODELS),
      reasoningOptionsForProvider: () => REASONING_OPTIONS,
      disabledReasonForProvider: (p) =>
        p === 'codex' ? 'Provider can only be changed before the first message' : undefined,
    });

    const rows = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-row__body')) as HTMLElement[];
    const codexRow = rows.find((r) => r.textContent?.includes('Codex'))!;
    expect(codexRow.getAttribute('aria-disabled')).toBe('true');
    expect(codexRow.getAttribute('title')).toContain('before the first message');
    const claudeRow = rows.find((r) => r.textContent?.includes('Claude'))!;
    expect(claudeRow.getAttribute('aria-disabled')).toBeNull();
  });

  it('falls back to the model id for a provider with no models', () => {
    setInputs({
      providers: ['cursor'],
      selectedProvider: 'cursor',
      selectedModelId: null,
      selectedReasoning: null,
      providerLabels: PROVIDER_LABELS,
      modelsForProvider: () => [],
      reasoningOptionsForProvider: () => [],
    });
    const cursor = fixture.componentInstance.menuModel().sections[0].items[0];
    expect(cursor.submenu?.emptyStateLabel).toBe('No models available');
  });
});
