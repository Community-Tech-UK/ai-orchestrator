import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { CompactModelPickerComponent } from './compact-model-picker.component';
import { InstanceStore } from '../../core/state/instance.store';
import { ChatStore } from '../../core/state/chat.store';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { UsageStore } from '../../core/state/usage.store';
import type { ChatRecord } from '../../../../shared/types/chat.types';
import type { PendingSelection } from './compact-model-picker.types';
import type { UnifiedSelection } from './unified-model-menu.component';

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

  beforeEach(() => {
    vi.clearAllMocks();
    selectedInstance.set(null);
    TestBed.configureTestingModule({
      imports: [CompactModelPickerComponent],
      providers: [
        { provide: InstanceStore, useValue: instanceStore },
        { provide: ChatStore, useValue: chatStore },
        { provide: ProviderStateService, useValue: providerState },
        { provide: UsageStore, useValue: usageStore },
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
      { provider: 'codex', model: 'gpt-5.5', reasoning: null },
    ]);
    // pending-create should NOT touch chatStore.
    expect(chatStore.setModel).not.toHaveBeenCalled();
  });

  it('cross-provider model commit clears reasoning (resets to null)', async () => {
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
      { provider: 'claude', model: 'sonnet', reasoning: null },
    ]);
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
});
