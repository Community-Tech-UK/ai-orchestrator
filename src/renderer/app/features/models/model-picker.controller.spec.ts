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
});
