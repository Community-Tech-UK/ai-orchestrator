import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { InstanceStore } from '../../core/state/instance.store';
import { UsageStore } from '../../core/state/usage.store';
import { ModelPickerController } from './model-picker.controller';

describe('ModelPickerController', () => {
  const selectedInstance = signal({
    id: 'inst-1',
    provider: 'claude',
    status: 'idle',
    currentModel: 'sonnet',
    agentId: 'build',
    workingDirectory: '/repo',
  });
  const instanceStore = {
    selectedInstance,
    changeModel: vi.fn(async () => undefined),
    changeAgentMode: vi.fn(async () => undefined),
  };
  const providerState = {
    selectedProvider: signal('claude'),
  };
  const usageStore = {
    record: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectedInstance.set({
      id: 'inst-1',
      provider: 'claude',
      status: 'idle',
      currentModel: 'sonnet',
      agentId: 'build',
      workingDirectory: '/repo',
    });
    TestBed.configureTestingModule({
      providers: [
        ModelPickerController,
        { provide: InstanceStore, useValue: instanceStore },
        { provide: ProviderStateService, useValue: providerState },
        { provide: UsageStore, useValue: usageStore },
      ],
    });
  });

  it('marks active-provider models available and other providers disabled', () => {
    const controller = TestBed.inject(ModelPickerController);
    const claudeGroup = controller.groups().find((group) => group.id === 'Claude');
    const codexGroup = controller.groups().find((group) => group.id === 'Codex');

    expect(claudeGroup?.items.some((item) => item.disabled)).toBe(false);
    expect(codexGroup?.items.some((item) => item.disabled)).toBe(true);
  });

  it('runs model changes for selected sessions', async () => {
    const controller = TestBed.inject(ModelPickerController);
    const item = controller.groups().find((group) => group.id === 'Claude')!.items[0];

    await controller.run(item);

    expect(instanceStore.changeModel).toHaveBeenCalledWith('inst-1', item.value.id);
  });

  it('stages model and thinking selections before applying them together', async () => {
    const controller = TestBed.inject(ModelPickerController) as ModelPickerController & {
      selectModel: (modelId: string) => void;
      selectReasoningEffort: (effort: 'high') => void;
      applySelection: () => Promise<boolean>;
    };

    controller.selectModel('sonnet[1m]');
    controller.selectReasoningEffort('high');

    await controller.applySelection();

    expect(instanceStore.changeModel).toHaveBeenCalledWith('inst-1', 'sonnet[1m]', 'high');
    expect(usageStore.record).toHaveBeenCalledWith('model', 'claude:sonnet[1m]:thinking-high', '/repo');
  });

  it('shows thinking choices for providers that support reasoning effort', () => {
    const controller = TestBed.inject(ModelPickerController) as ModelPickerController & {
      reasoningOptions: () => { id: string; label: string }[];
    };

    expect(controller.reasoningOptions().map((option) => option.id)).toEqual([
      'default',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('disables model changes while the selected session is not waiting for user input', () => {
    selectedInstance.update((instance) => ({
      ...instance,
      status: 'waiting_for_permission',
    }));

    const controller = TestBed.inject(ModelPickerController);
    const claudeGroup = controller.groups().find((group) => group.id === 'Claude');

    expect(claudeGroup?.items.every((item) => item.disabled)).toBe(true);
    expect(claudeGroup?.items[0].disabledReason).toContain('waiting for user input');
  });
});
