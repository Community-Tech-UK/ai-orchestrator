import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { BUILTIN_AGENTS } from '../../../../shared/types/agent.types';
import {
  getModelsForProvider,
  type ModelDisplayInfo,
  type ReasoningEffort,
} from '../../../../shared/types/provider.types';
import { getModelSwitchUnavailableReason } from '../../../../shared/types/instance-status-policy';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { InstanceStore } from '../../core/state/instance.store';
import { UsageStore } from '../../core/state/usage.store';
import type { InstanceProvider } from '../../core/state/instance/instance.types';
import type { OverlayController, OverlayGroup, OverlayItem } from '../overlay/overlay.types';
import type { ModelPickerItem } from '../../../../shared/types/prompt-history.types';

const PROVIDERS: InstanceProvider[] = ['claude', 'codex', 'gemini', 'copilot', 'cursor'];

const PROVIDER_LABELS: Record<InstanceProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  ollama: 'Ollama',
  copilot: 'Copilot',
  cursor: 'Cursor',
};

const PROVIDER_COLORS: Record<InstanceProvider, string> = {
  claude: '#d97706',
  codex: '#10a37f',
  gemini: '#4285f4',
  ollama: '#888888',
  copilot: '#a855f7',
  cursor: '#0f172a',
};

export interface ModelPickerProviderOption {
  id: InstanceProvider;
  label: string;
  color: string;
  available: boolean;
  disabledReason?: string;
}

export interface ModelPickerReasoningOption {
  id: 'default' | ReasoningEffort;
  label: string;
  description: string;
}

@Injectable({ providedIn: 'root' })
export class ModelPickerController implements OverlayController<ModelPickerItem> {
  private readonly providerState = inject(ProviderStateService);
  private readonly instanceStore = inject(InstanceStore);
  private readonly usageStore = inject(UsageStore);

  readonly title = 'Model picker';
  readonly placeholder = 'Search models or agents...';
  readonly emptyLabel = 'No models found';
  readonly query = signal('');
  readonly selectedProviderId = signal<InstanceProvider>('claude');
  readonly selectedModelId = signal('');
  readonly selectedReasoningEffort = signal<ReasoningEffort | null>(null);
  readonly applying = signal(false);

  constructor() {
    effect(() => {
      const selected = this.instanceStore.selectedInstance();
      const provider = selected?.provider ?? this.activeProvider() ?? 'claude';
      this.selectedProviderId.set(provider);
      this.selectedModelId.set(selected?.currentModel ?? this.defaultModelForProvider(provider));
      this.selectedReasoningEffort.set(selected?.reasoningEffort ?? null);
    });
  }

  private readonly activeProvider = computed<InstanceProvider | null>(() => {
    const selected = this.instanceStore.selectedInstance();
    if (selected) {
      return selected.provider;
    }
    const provider = this.providerState.selectedProvider();
    return provider === 'auto' ? null : provider;
  });

  private readonly items = computed<ModelPickerItem[]>(() => {
    const activeProvider = this.activeProvider();
    const selected = this.instanceStore.selectedInstance();
    const modelSwitchUnavailableReason = selected
      ? getModelSwitchUnavailableReason(selected.status)
      : undefined;
    const modelItems = PROVIDERS.flatMap((provider) => {
      const seen = new Set<string>();
      return getModelsForProvider(provider)
        .filter((model) => {
          if (seen.has(model.id)) return false;
          seen.add(model.id);
          return true;
        })
        .map((model): ModelPickerItem => ({
          id: model.id,
          label: model.name,
          group: PROVIDER_LABELS[provider],
          kind: 'model',
          available: provider === activeProvider && !modelSwitchUnavailableReason,
          disabledReason: provider === activeProvider
            ? modelSwitchUnavailableReason
            : `Requires ${PROVIDER_LABELS[provider]} provider`,
          tags: [model.tier],
        }));
    });

    const agentItems = BUILTIN_AGENTS.map((agent): ModelPickerItem => ({
      id: agent.id,
      label: agent.name,
      group: 'Agents',
      kind: 'agent',
      available: !!this.instanceStore.selectedInstance(),
      disabledReason: this.instanceStore.selectedInstance()
        ? undefined
        : 'Requires a selected live session',
      tags: [agent.mode],
    }));

    return [...modelItems, ...agentItems];
  });

  readonly providerOptions = computed<ModelPickerProviderOption[]>(() => {
    const activeProvider = this.activeProvider();
    const selected = this.instanceStore.selectedInstance();
    const modelSwitchUnavailableReason = selected
      ? getModelSwitchUnavailableReason(selected.status)
      : 'Requires a selected live session';

    return PROVIDERS.map((provider) => ({
      id: provider,
      label: PROVIDER_LABELS[provider],
      color: PROVIDER_COLORS[provider],
      available: provider === activeProvider && !modelSwitchUnavailableReason,
      disabledReason: provider === activeProvider
        ? modelSwitchUnavailableReason
        : `Requires ${PROVIDER_LABELS[provider]} provider`,
    }));
  });

  readonly selectedProviderOption = computed(() =>
    this.providerOptions().find((provider) => provider.id === this.selectedProviderId())
      ?? this.providerOptions()[0],
  );

  readonly selectedProviderModels = computed<ModelDisplayInfo[]>(() => {
    const query = this.query().trim().toLowerCase();
    const seen = new Set<string>();
    return getModelsForProvider(this.selectedProviderId())
      .filter((model) => {
        if (seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      })
      .filter((model) => {
        if (!query) return true;
        return [model.id, model.name, model.tier].some((value) =>
          value.toLowerCase().includes(query)
        );
      });
  });

  readonly selectedModel = computed(() =>
    this.selectedProviderModels().find((model) => model.id === this.selectedModelId())
      ?? getModelsForProvider(this.selectedProviderId()).find((model) => model.id === this.selectedModelId())
      ?? this.selectedProviderModels()[0],
  );

  readonly reasoningOptions = computed<ModelPickerReasoningOption[]>(() => {
    const provider = this.selectedProviderId();
    const defaults: ModelPickerReasoningOption[] = [
      { id: 'default', label: 'Default', description: 'Let the provider decide' },
    ];

    if (provider === 'claude') {
      return [
        ...defaults,
        { id: 'low', label: 'Low', description: 'Shorter thinking' },
        { id: 'medium', label: 'Medium', description: 'Balanced thinking' },
        { id: 'high', label: 'High', description: 'Deeper thinking' },
        { id: 'xhigh', label: 'Max', description: 'Largest thinking budget' },
      ];
    }

    if (provider === 'codex') {
      return [
        ...defaults,
        { id: 'none', label: 'Off', description: 'No extra reasoning effort' },
        { id: 'minimal', label: 'Minimal', description: 'Light reasoning' },
        { id: 'low', label: 'Low', description: 'Shorter thinking' },
        { id: 'medium', label: 'Medium', description: 'Balanced thinking' },
        { id: 'high', label: 'High', description: 'Deeper thinking' },
        { id: 'xhigh', label: 'Max', description: 'Largest thinking budget' },
      ];
    }

    return [];
  });

  readonly selectedReasoningId = computed<'default' | ReasoningEffort>(
    () => this.selectedReasoningEffort() ?? 'default'
  );

  readonly hasSelectionChanged = computed(() => {
    const selected = this.instanceStore.selectedInstance();
    if (!selected) return false;
    return (
      selected.currentModel !== this.selectedModelId() ||
      (selected.reasoningEffort ?? null) !== this.selectedReasoningEffort()
    );
  });

  readonly applyDisabledReason = computed(() => {
    const selected = this.instanceStore.selectedInstance();
    if (!selected) return 'Requires a selected live session';
    const provider = this.selectedProviderOption();
    if (!provider?.available) return provider?.disabledReason ?? 'Provider unavailable';
    if (!this.selectedModelId()) return 'Select a model version';
    return undefined;
  });

  readonly groups = computed<OverlayGroup<ModelPickerItem>[]>(() => {
    const query = this.query().trim().toLowerCase();
    const grouped = new Map<string, OverlayItem<ModelPickerItem>[]>();

    for (const item of this.items().filter((candidate) => this.matches(candidate, query))) {
      const list = grouped.get(item.group) ?? [];
      list.push(this.toOverlayItem(item));
      grouped.set(item.group, list);
    }

    return [...grouped.entries()].map(([id, items]) => ({
      id,
      label: id,
      items: items.sort((left, right) =>
        Number(right.value.available) - Number(left.value.available) || left.label.localeCompare(right.label),
      ),
    }));
  });

  setQuery(query: string): void {
    this.query.set(query);
  }

  selectProvider(providerId: InstanceProvider): void {
    const provider = this.providerOptions().find((option) => option.id === providerId);
    if (!provider?.available) return;

    this.selectedProviderId.set(providerId);
    this.selectedModelId.set(this.defaultModelForProvider(providerId));
    this.selectedReasoningEffort.set(null);
  }

  selectModel(modelId: string): void {
    this.selectedModelId.set(modelId);
  }

  selectReasoningEffort(effort: 'default' | ReasoningEffort): void {
    this.selectedReasoningEffort.set(effort === 'default' ? null : effort);
  }

  async applySelection(): Promise<boolean> {
    if (this.applyDisabledReason()) return false;

    const selected = this.instanceStore.selectedInstance();
    const modelId = this.selectedModelId();
    if (!selected || !modelId) return false;

    this.applying.set(true);
    try {
      const reasoningEffort = this.selectedReasoningEffort();
      await this.instanceStore.changeModel(selected.id, modelId, reasoningEffort);
      const thinkingSegment = reasoningEffort ? `thinking-${reasoningEffort}` : 'thinking-default';
      await this.usageStore.record(
        'model',
        `${selected.provider}:${modelId}:${thinkingSegment}`,
        selected.workingDirectory
      );
      return true;
    } finally {
      this.applying.set(false);
    }
  }

  async run(item: OverlayItem<ModelPickerItem>): Promise<boolean> {
    if (item.disabled) {
      return false;
    }

    const selected = this.instanceStore.selectedInstance();
    if (!selected) {
      return false;
    }

    if (item.value.kind === 'agent') {
      await this.instanceStore.changeAgentMode(selected.id, item.value.id);
      await this.usageStore.record('model', `agent:${item.value.id}`, selected.workingDirectory);
      return true;
    }

    await this.instanceStore.changeModel(selected.id, item.value.id);
    await this.usageStore.record('model', `${selected.provider}:${item.value.id}`, selected.workingDirectory);
    return true;
  }

  private toOverlayItem(item: ModelPickerItem): OverlayItem<ModelPickerItem> {
    const selected = this.instanceStore.selectedInstance();
    const isCurrent =
      item.kind === 'model'
        ? selected?.currentModel === item.id
        : selected?.agentId === item.id;

    return {
      id: `${item.kind}:${item.group}:${item.id}`,
      label: item.label,
      description: item.kind === 'model' ? item.id : item.tags?.join(', '),
      detail: item.tags?.join(' · '),
      badge: isCurrent ? 'Current' : item.kind === 'agent' ? 'Agent' : item.group,
      disabled: !item.available,
      disabledReason: item.disabledReason,
      keywords: [item.id, item.label, item.group, ...(item.tags ?? [])],
      value: item,
    };
  }

  private matches(item: ModelPickerItem, query: string): boolean {
    if (!query) return true;
    return [item.id, item.label, item.group, item.kind, ...(item.tags ?? [])]
      .some((value) => value.toLowerCase().includes(query));
  }

  private defaultModelForProvider(provider: InstanceProvider): string {
    return getModelsForProvider(provider)[0]?.id ?? '';
  }
}
