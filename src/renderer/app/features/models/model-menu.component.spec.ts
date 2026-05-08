import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  ModelMenuComponent,
  versionDescending,
  type ModelMenuReasoningOption,
  type ModelMenuSelection,
} from './model-menu.component';
import type { ModelDisplayInfo, ReasoningEffort } from '../../../../shared/types/provider.types';

const reasoning = (id: 'default' | ReasoningEffort, label: string) => ({ id, label });

const REASONING_OPTIONS: ModelMenuReasoningOption[] = [
  reasoning('default', 'Default'),
  reasoning('low', 'Low'),
  reasoning('medium', 'Medium'),
  reasoning('high', 'High'),
];

describe('ModelMenuComponent', () => {
  let fixture: ComponentFixture<ModelMenuComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ModelMenuComponent] });
    fixture = TestBed.createComponent(ModelMenuComponent);
  });

  function setInputs(overrides: Partial<{
    provider: string;
    models: ModelDisplayInfo[];
    selectedModelId: string | null;
    selectedReasoning: ReasoningEffort | null;
    reasoningOptions: typeof REASONING_OPTIONS;
  }>): void {
    if (overrides.provider !== undefined) fixture.componentRef.setInput('provider', overrides.provider);
    if (overrides.models !== undefined) fixture.componentRef.setInput('models', overrides.models);
    if (overrides.selectedModelId !== undefined) fixture.componentRef.setInput('selectedModelId', overrides.selectedModelId);
    if (overrides.selectedReasoning !== undefined) fixture.componentRef.setInput('selectedReasoning', overrides.selectedReasoning);
    if (overrides.reasoningOptions !== undefined) fixture.componentRef.setInput('reasoningOptions', overrides.reasoningOptions);
    fixture.detectChanges();
  }

  it('renders pinned models in a header-less Latest section first, then Other versions', () => {
    setInputs({
      models: [
        { id: 'opus', name: 'Opus latest', tier: 'powerful', pinned: true, family: 'Opus' },
        { id: 'opus-4-7', name: 'Opus 4.7', tier: 'powerful', family: 'Opus' },
        { id: 'sonnet', name: 'Sonnet latest', tier: 'balanced', pinned: true, family: 'Sonnet' },
      ],
    });

    const labels = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-row__label'))
      .map((el) => (el as HTMLElement).textContent?.trim());
    expect(labels.slice(0, 3)).toEqual(['Opus latest', 'Sonnet latest', 'Other versions']);
  });

  it('shows the empty-state when there are no other versions', () => {
    setInputs({
      models: [
        { id: 'auto', name: 'Auto', tier: 'balanced', pinned: true, family: 'Auto' },
      ],
    });

    const otherVersionsItem = fixture.componentInstance.menuModel().sections
      .flatMap((s) => s.items)
      .find((i) => i.id === '__other_versions__');
    expect(otherVersionsItem?.submenu?.emptyStateLabel).toBe('No additional versions available');
  });

  it('attaches an Intelligence submenu only when reasoningOptions is non-empty', () => {
    setInputs({
      models: [{ id: 'opus', name: 'Opus latest', tier: 'powerful', pinned: true, family: 'Opus' }],
      reasoningOptions: [],
    });
    let pinned = fixture.componentInstance.menuModel().sections[0].items[0];
    expect(pinned.submenu).toBeUndefined();

    setInputs({ reasoningOptions: REASONING_OPTIONS });
    pinned = fixture.componentInstance.menuModel().sections[0].items[0];
    expect(pinned.submenu?.sections[0].label).toBe('Intelligence');
    expect(pinned.submenu?.sections[0].items.map((i) => i.label))
      .toEqual(['Default', 'Low', 'Medium', 'High']);
  });

  it('clicking a model row emits modelSelect preserving current reasoning', () => {
    setInputs({
      models: [
        { id: 'opus', name: 'Opus latest', tier: 'powerful', pinned: true, family: 'Opus' },
      ],
      selectedReasoning: 'high',
    });
    let emitted: ModelMenuSelection | null = null;
    fixture.componentInstance.modelSelect.subscribe((s) => (emitted = s));

    const opusRow = Array.from(fixture.nativeElement.querySelectorAll('.menu-item-row__body'))
      .find((el) => (el as HTMLElement).textContent?.includes('Opus latest')) as HTMLElement;
    opusRow.click();

    expect(emitted).toEqual({ modelId: 'opus', reasoning: 'high' });
  });

  it('clicking a reasoning leaf emits modelSelect with the chosen level and parent model', () => {
    setInputs({
      models: [{ id: 'opus', name: 'Opus latest', tier: 'powerful', pinned: true, family: 'Opus' }],
      reasoningOptions: REASONING_OPTIONS,
    });
    let emitted: ModelMenuSelection | null = null;
    fixture.componentInstance.modelSelect.subscribe((s) => (emitted = s));

    const opusRow = fixture.componentInstance.menuModel().sections[0].items[0];
    const highReasoning = opusRow.submenu!.sections[0].items.find((i) => i.label === 'High')!;
    fixture.componentInstance.onSelect(highReasoning);

    expect(emitted).toEqual({ modelId: 'opus', reasoning: 'high' });
  });

  it('Default reasoning leaf emits null reasoning', () => {
    setInputs({
      models: [{ id: 'opus', name: 'Opus latest', tier: 'powerful', pinned: true, family: 'Opus' }],
      reasoningOptions: REASONING_OPTIONS,
      selectedReasoning: 'high',
    });
    let emitted: ModelMenuSelection | null = null;
    fixture.componentInstance.modelSelect.subscribe((s) => (emitted = s));

    const opusRow = fixture.componentInstance.menuModel().sections[0].items[0];
    const defaultLevel = opusRow.submenu!.sections[0].items.find((i) => i.label === 'Default')!;
    fixture.componentInstance.onSelect(defaultLevel);

    expect(emitted).toEqual({ modelId: 'opus', reasoning: null });
  });

  it('Other versions submenu sections by family with version-descending order', () => {
    setInputs({
      models: [
        { id: 'opus', name: 'Opus latest', tier: 'powerful', pinned: true, family: 'Opus' },
        { id: 'sonnet', name: 'Sonnet latest', tier: 'balanced', pinned: true, family: 'Sonnet' },
        { id: 'opus-4-7', name: 'Opus 4.7', tier: 'powerful', family: 'Opus' },
        { id: 'opus-4-6', name: 'Opus 4.6', tier: 'powerful', family: 'Opus' },
        { id: 'sonnet-4-6', name: 'Sonnet 4.6', tier: 'balanced', family: 'Sonnet' },
      ],
    });

    const otherVersionsItem = fixture.componentInstance.menuModel().sections
      .flatMap((s) => s.items)
      .find((i) => i.id === '__other_versions__')!;
    const familySections = otherVersionsItem.submenu!.sections;
    expect(familySections.map((s) => s.label)).toEqual(['Opus', 'Sonnet']);
    expect(familySections[0].items.map((i) => i.label)).toEqual(['Opus 4.7', 'Opus 4.6']);
  });
});

describe('versionDescending', () => {
  function info(name: string, id: string): ModelDisplayInfo {
    return { id, name, tier: 'powerful' };
  }

  it('orders newer versions first within a family', () => {
    const items = [
      info('Opus 4', 'opus-4'),
      info('Opus 4.7', 'opus-4-7'),
      info('Opus 4.5', 'opus-4-5'),
      info('Opus 4.6', 'opus-4-6'),
    ];
    items.sort(versionDescending);
    expect(items.map((i) => i.name)).toEqual(['Opus 4.7', 'Opus 4.6', 'Opus 4.5', 'Opus 4']);
  });

  it('handles two-decimal versions correctly (1.10 > 1.9)', () => {
    const items = [info('Foo 1.9', 'foo-1-9'), info('Foo 1.10', 'foo-1-10')];
    items.sort(versionDescending);
    expect(items.map((i) => i.name)).toEqual(['Foo 1.10', 'Foo 1.9']);
  });

  it('falls back to alphabetical descending for non-numeric names', () => {
    const items = [info('Auto', 'auto'), info('Custom', 'custom')];
    items.sort(versionDescending);
    expect(items.map((i) => i.name)).toEqual(['Custom', 'Auto']);
  });
});
