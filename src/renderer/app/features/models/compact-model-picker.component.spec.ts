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

  it('renders the provider chip and model trigger with current chat values', () => {
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord({ provider: 'claude', model: 'sonnet' }));
    fixture.detectChanges();

    const labels = Array.from(fixture.nativeElement.querySelectorAll('.compact-picker__label'))
      .map((el) => (el as HTMLElement).textContent?.trim());
    expect(labels[0]).toBe('Claude');
    expect(labels[1]).toBe('Sonnet latest');
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

  it('disables the provider chip when chat has messages and provider is set', () => {
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord({ provider: 'claude' }));
    fixture.componentRef.setInput('hasMessages', true);
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector('.compact-picker__chip--provider') as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute('title')).toContain('before the first message');
  });

  it('opens the provider menu when the provider chip is clicked', () => {
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord());
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector('.compact-picker__chip--provider') as HTMLButtonElement;
    chip.click();
    fixture.detectChanges();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens the model menu when the model trigger is clicked', () => {
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord());
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector('.compact-picker__chip--model') as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('opening one menu closes the other', () => {
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord());
    fixture.detectChanges();

    const provider = fixture.nativeElement.querySelector('.compact-picker__chip--provider') as HTMLButtonElement;
    const model = fixture.nativeElement.querySelector('.compact-picker__chip--model') as HTMLButtonElement;

    provider.click();
    fixture.detectChanges();
    expect(provider.getAttribute('aria-expanded')).toBe('true');

    model.click();
    fixture.detectChanges();
    expect(provider.getAttribute('aria-expanded')).toBe('false');
    expect(model.getAttribute('aria-expanded')).toBe('true');
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

    // Simulate the model menu emitting a selection.
    await (fixture.componentInstance as unknown as {
      onModelSelect: (s: { modelId: string; reasoning?: 'high' | null }) => Promise<void>
    }).onModelSelect({ modelId: 'gpt-5.5', reasoning: null });

    expect(emitted).toEqual([
      { provider: 'codex', model: 'gpt-5.5', reasoning: null },
    ]);
    // pending-create should NOT touch chatStore.
    expect(chatStore.setModel).not.toHaveBeenCalled();
  });

  it('flashes a status pill after commit and clears it after 2 seconds', async () => {
    vi.useFakeTimers();
    fixture.componentRef.setInput('mode', 'live-instance');
    fixture.componentRef.setInput('chat', chatRecord({ provider: 'claude', model: 'sonnet' }));
    fixture.detectChanges();

    await (fixture.componentInstance as unknown as {
      onModelSelect: (s: { modelId: string; reasoning?: 'high' | null }) => Promise<void>
    }).onModelSelect({ modelId: 'opus', reasoning: null });
    fixture.detectChanges();

    let pill = fixture.nativeElement.querySelector('.compact-picker__status') as HTMLElement;
    expect(pill?.textContent).toContain('Switched to Opus latest');

    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
    pill = fixture.nativeElement.querySelector('.compact-picker__status') as HTMLElement;
    expect(pill).toBeNull();
  });
});
