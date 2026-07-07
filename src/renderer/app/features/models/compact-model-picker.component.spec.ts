import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { CompactModelPickerComponent } from './compact-model-picker.component';
import { InstanceStore } from '../../core/state/instance.store';
import { ChatStore } from '../../core/state/chat.store';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { UsageStore } from '../../core/state/usage.store';
import {
  getModelsForProvider,
  type ModelDisplayInfo,
} from '../../../../shared/types/provider.types';
import type { ChatRecord } from '../../../../shared/types/chat.types';
import type { PendingSelection } from './compact-model-picker.types';
import type { UnifiedSelection } from './model-selection.types';
import { DynamicModelCatalogService } from './dynamic-model-catalog.service';
import { UnifiedCatalogStore } from './unified-catalog.store';

function chatRecord(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: 'chat-1',
    name: 'Picker',
    provider: 'claude',
    model: 'sonnet',
    reasoningEffort: null,
    currentCwd: '/repo',
    projectId: null,
    yolo: false,
    ledgerThreadId: 'thread-1',
    currentInstanceId: null,
    createdAt: 1,
    lastActiveAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

describe('CompactModelPickerComponent', () => {
  let fixture: ComponentFixture<CompactModelPickerComponent>;

  const selectedInstance = signal<unknown>(null);
  const instanceStore = {
    selectedInstance,
    changeModel: vi.fn(async () => undefined),
    changeAgentMode: vi.fn(async () => undefined),
  };
  const providerState = { selectedProvider: signal('claude') };
  const usageStore = { record: vi.fn(async () => undefined) };
  const chatStore = {
    setProvider: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setReasoning: vi.fn(async () => undefined),
  };
  let unifiedModelsByProvider: Record<string, ModelDisplayInfo[]>;
  const dynamicCatalog = {
    ensureLoaded: vi.fn(),
    modelsFor: vi.fn((provider: string) => getModelsForProvider(provider)),
  };
  const unifiedCatalog = {
    ensureLoaded: vi.fn(),
    displayModelsForProvider: vi.fn((provider: string) => unifiedModelsByProvider[provider] ?? []),
    lastBuiltAt: signal<number | null>(null),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectedInstance.set(null);
    unifiedModelsByProvider = {};
    unifiedCatalog.lastBuiltAt.set(null);
    TestBed.configureTestingModule({
      imports: [CompactModelPickerComponent],
      providers: [
        { provide: InstanceStore, useValue: instanceStore },
        { provide: ChatStore, useValue: chatStore },
        { provide: ProviderStateService, useValue: providerState },
        { provide: UsageStore, useValue: usageStore },
        { provide: DynamicModelCatalogService, useValue: dynamicCatalog },
        { provide: UnifiedCatalogStore, useValue: unifiedCatalog },
      ],
    });
    fixture = TestBed.createComponent(CompactModelPickerComponent);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders one chip showing provider, model, and chevron', () => {
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord({ provider: 'claude', model: 'sonnet' }));
    fixture.detectChanges();

    const chips = fixture.nativeElement.querySelectorAll('.compact-picker__chip');
    expect(chips.length).toBe(1);

    const labels = Array.from(fixture.nativeElement.querySelectorAll('.compact-picker__label'))
      .map((el) => (el as HTMLElement).textContent?.trim());
    // First label is provider name, second is model name.
    expect(labels[0]).toBe('Claude');
    expect(labels[1]).toBe('Sonnet latest');

    const chevron = fixture.nativeElement.querySelector('.compact-picker__chevron');
    expect(chevron).not.toBeNull();
  });

  it('uses unified catalog rows for strict-provider catalog-only selected models', () => {
    unifiedModelsByProvider['claude'] = [
      { id: 'claude-future-opus', name: 'Future Opus', tier: 'powerful', family: 'Opus' },
    ];
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord({
      provider: 'claude',
      model: 'claude-future-opus',
    }));
    fixture.detectChanges();

    const labels = Array.from(fixture.nativeElement.querySelectorAll('.compact-picker__label'))
      .map((el) => (el as HTMLElement).textContent?.trim());
    expect(labels[1]).toBe('Future Opus');
    expect(dynamicCatalog.modelsFor).not.toHaveBeenCalled();
  });

  it('shows the reasoning suffix only when reasoning is non-null', () => {
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord({ provider: 'claude', model: 'sonnet', reasoningEffort: null }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.compact-picker__reasoning-suffix')).toBeNull();

    fixture.componentRef.setInput('chat', chatRecord({ provider: 'claude', model: 'sonnet', reasoningEffort: 'high' }));
    fixture.detectChanges();
    const suffix = fixture.nativeElement.querySelector('.compact-picker__reasoning-suffix') as HTMLElement;
    expect(suffix?.textContent).toContain('High');
  });

  it('opens the unified menu when the chip is clicked', () => {
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord());
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector('.compact-picker__chip') as HTMLButtonElement;
    chip.click();
    fixture.detectChanges();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
  });

  it('disables the chip and refuses to open when disabledReason is set', () => {
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord());
    fixture.componentRef.setInput('disabledReason', 'Busy — try again when idle');
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector('.compact-picker__chip') as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute('title')).toBe('Busy — try again when idle');

    chip.click();
    fixture.detectChanges();
    expect(chip.getAttribute('aria-expanded')).toBe('false');

    // Re-enabling lets it open again.
    fixture.componentRef.setInput('disabledReason', null);
    fixture.detectChanges();
    expect(chip.disabled).toBe(false);
    chip.click();
    fixture.detectChanges();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
  });

  it('chip stays clickable even when the chat is locked-on-messages', () => {
    // Locking is now applied at the menu level (per-provider rows) rather
    // than at the chip — clicking the chip must still open the menu so the
    // user can change model/reasoning within the same provider after the
    // first message.
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord({ provider: 'claude' }));
    fixture.componentRef.setInput('hasMessages', true);
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector('.compact-picker__chip') as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
    chip.click();
    fixture.detectChanges();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
  });

  it('emits selectionChange in pending-create mode when a model is committed', async () => {
    fixture.componentRef.setInput('mode', 'pending-create');
    fixture.componentRef.setInput('selection', {
      provider: 'codex',
      model: null,
      reasoning: null,
    } satisfies PendingSelection);
    fixture.detectChanges();

    const emitted: PendingSelection[] = [];
    fixture.componentInstance.selectionChange.subscribe((s) => emitted.push(s));

    // Simulate the unified menu emitting a model selection within the
    // currently-selected provider (codex).
    await (fixture.componentInstance as unknown as {
      onUnifiedSelect: (s: UnifiedSelection) => Promise<void>;
    }).onUnifiedSelect({ kind: 'model', provider: 'codex', modelId: 'gpt-5.5' });

    expect(emitted).toEqual([
      { provider: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' },
    ]);
    // pending-create should NOT touch chatStore.
    expect(chatStore.setModel).not.toHaveBeenCalled();
  });

  it('cross-provider model commit restores provider default reasoning', async () => {
    fixture.componentRef.setInput('mode', 'pending-create');
    fixture.componentRef.setInput('selection', {
      provider: 'codex',
      model: 'gpt-5.5',
      reasoning: 'high',
    } satisfies PendingSelection);
    fixture.detectChanges();

    const emitted: PendingSelection[] = [];
    fixture.componentInstance.selectionChange.subscribe((s) => emitted.push(s));

    await (fixture.componentInstance as unknown as {
      onUnifiedSelect: (s: UnifiedSelection) => Promise<void>;
    }).onUnifiedSelect({ kind: 'model', provider: 'claude', modelId: 'sonnet' });

    expect(emitted).toEqual([
      { provider: 'claude', model: 'sonnet', reasoning: 'high' },
    ]);
  });

  it('live provider row commits the unified-catalog default model with default reasoning', async () => {
    unifiedModelsByProvider['codex'] = [
      { id: 'gpt-live-codex', name: 'Live Codex', tier: 'powerful', family: 'GPT' },
      { id: 'gpt-5.5', name: 'GPT 5.5', tier: 'balanced', family: 'GPT' },
    ];
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord({ provider: 'claude', model: 'sonnet', reasoningEffort: null }));
    fixture.detectChanges();

    await (fixture.componentInstance as unknown as {
      onUnifiedSelect: (s: UnifiedSelection) => Promise<void>;
    }).onUnifiedSelect({ kind: 'provider', provider: 'codex' });

    expect(chatStore.setProvider).toHaveBeenCalledWith('chat-1', 'codex');
    expect(chatStore.setModel).toHaveBeenCalledWith('chat-1', 'gpt-live-codex');
    expect(chatStore.setReasoning).toHaveBeenCalledWith('chat-1', 'xhigh');
  });

  it('live model row commits the selected model and restores provider default reasoning', async () => {
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord({
      provider: 'codex',
      model: 'gpt-5.2',
      reasoningEffort: 'medium',
    }));
    fixture.detectChanges();

    await (fixture.componentInstance as unknown as {
      onUnifiedSelect: (s: UnifiedSelection) => Promise<void>;
    }).onUnifiedSelect({ kind: 'model', provider: 'codex', modelId: 'gpt-5.5-mini' });

    expect(chatStore.setProvider).not.toHaveBeenCalled();
    expect(chatStore.setModel).toHaveBeenCalledWith('chat-1', 'gpt-5.5-mini');
    expect(chatStore.setReasoning).toHaveBeenCalledWith('chat-1', 'xhigh');
  });

  it('reasoning-leaf commit emits provider+model+reasoning together', async () => {
    fixture.componentRef.setInput('mode', 'pending-create');
    fixture.componentRef.setInput('selection', {
      provider: 'claude',
      model: 'sonnet',
      reasoning: null,
    } satisfies PendingSelection);
    fixture.detectChanges();

    const emitted: PendingSelection[] = [];
    fixture.componentInstance.selectionChange.subscribe((s) => emitted.push(s));

    await (fixture.componentInstance as unknown as {
      onUnifiedSelect: (s: UnifiedSelection) => Promise<void>;
    }).onUnifiedSelect({
      kind: 'reasoning',
      provider: 'claude',
      modelId: 'opus',
      level: 'high',
    });

    expect(emitted).toEqual([
      { provider: 'claude', model: 'opus', reasoning: 'high' },
    ]);
  });

  it('provider-only commit clears reasoning and picks the primary default model', async () => {
    fixture.componentRef.setInput('mode', 'pending-create');
    fixture.componentRef.setInput('selection', {
      provider: 'claude',
      model: 'sonnet',
      reasoning: 'high',
    } satisfies PendingSelection);
    fixture.detectChanges();

    const emitted: PendingSelection[] = [];
    fixture.componentInstance.selectionChange.subscribe((s) => emitted.push(s));

    await (fixture.componentInstance as unknown as {
      onUnifiedSelect: (s: UnifiedSelection) => Promise<void>;
    }).onUnifiedSelect({ kind: 'provider', provider: 'gemini' });

    expect(emitted.length).toBe(1);
    const next = emitted[0];
    expect(next.provider).toBe('gemini');
    expect(next.reasoning).toBeNull();
    // The exact default-model id comes from PROVIDER_MODEL_LIST['gemini'][0].id.
    expect(next.model).toBeTruthy();
  });

  it('flashes a status pill after commit and clears it after 2 seconds', async () => {
    vi.useFakeTimers();
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord({ provider: 'claude', model: 'sonnet' }));
    fixture.detectChanges();

    await (fixture.componentInstance as unknown as {
      onUnifiedSelect: (s: UnifiedSelection) => Promise<void>;
    }).onUnifiedSelect({ kind: 'model', provider: 'claude', modelId: 'opus' });
    fixture.detectChanges();

    let pill = fixture.nativeElement.querySelector('.compact-picker__status') as HTMLElement;
    expect(pill?.textContent).toContain('Switched to Opus latest');

    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
    pill = fixture.nativeElement.querySelector('.compact-picker__status') as HTMLElement;
    expect(pill).toBeNull();
  });

  it('updates catalog freshness as time passes and clears timers on destroy', () => {
    fixture.destroy();
    vi.useFakeTimers();
    const builtAt = 1_000_000;
    vi.setSystemTime(builtAt);
    unifiedCatalog.lastBuiltAt.set(builtAt);
    fixture = TestBed.createComponent(CompactModelPickerComponent);
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord({ provider: 'claude', model: 'sonnet' }));
    fixture.detectChanges();

    let freshness = fixture.nativeElement.querySelector('.compact-picker__catalog') as HTMLElement;
    expect(freshness?.textContent).toContain('just now');

    vi.setSystemTime(builtAt + 60_000);
    vi.advanceTimersByTime(60_000);
    fixture.detectChanges();

    freshness = fixture.nativeElement.querySelector('.compact-picker__catalog') as HTMLElement;
    expect(freshness?.textContent).toContain('2m ago');

    fixture.destroy();
    vi.advanceTimersByTime(60_000);
  });
});
