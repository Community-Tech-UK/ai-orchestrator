import { Injectable, computed, inject, signal } from '@angular/core';
import { BUILTIN_AGENTS } from '../../../../shared/types/agent.types';
import { getModelsForProvider } from '../../../../shared/types/provider.types';
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

@Injectable({ providedIn: 'root' })
export class ModelPickerController implements OverlayController<ModelPickerItem> {
  private readonly providerState = inject(ProviderStateService);
  private readonly instanceStore = inject(InstanceStore);
  private readonly usageStore = inject(UsageStore);

  readonly title = 'Model picker';
  readonly placeholder = 'Search models or agents...';
  readonly emptyLabel = 'No models found';
  readonly query = signal('');

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
}
