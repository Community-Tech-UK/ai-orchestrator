import { Injectable, computed, inject, signal } from '@angular/core';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { UsageStore } from '../../core/state/usage.store';
import type { OverlayController, OverlayGroup, OverlayItem } from '../overlay/overlay.types';
import type { SessionPickerItem } from '../../../../shared/types/prompt-history.types';

function formatAge(timestamp?: number): string {
  if (!timestamp) {
    return '';
  }
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

@Injectable({ providedIn: 'root' })
export class SessionPickerController implements OverlayController<SessionPickerItem> {
  private readonly instanceStore = inject(InstanceStore);
  private readonly historyStore = inject(HistoryStore);
  private readonly usageStore = inject(UsageStore);

  readonly title = 'Session picker';
  readonly placeholder = 'Search sessions...';
  readonly emptyLabel = 'No sessions found';
  readonly query = signal('');

  private readonly items = computed<SessionPickerItem[]>(() => {
    const live = this.instanceStore.instances().map((instance): SessionPickerItem => ({
      id: instance.id,
      title: instance.displayName || instance.sessionId || instance.id,
      subtitle: [
        instance.provider,
        instance.currentModel,
        instance.workingDirectory,
        formatAge(instance.lastActivity),
      ].filter(Boolean).join(' · '),
      projectPath: instance.workingDirectory,
      provider: instance.provider,
      kind: 'live',
      lastActivity: instance.lastActivity,
      frecencyScore: this.usageStore.frecency('session', instance.id),
    }));

    const history = this.historyStore.entries().map((entry): SessionPickerItem => ({
      id: entry.id,
      title: entry.displayName || entry.firstUserMessage || entry.sessionId,
      subtitle: [
        entry.provider,
        entry.workingDirectory,
        formatAge(entry.endedAt || entry.createdAt),
      ].filter(Boolean).join(' · '),
      projectPath: entry.workingDirectory,
      provider: entry.provider,
      kind: entry.archivedAt ? 'archived' : 'history',
      lastActivity: entry.endedAt || entry.createdAt,
      frecencyScore: this.usageStore.frecency('session', entry.id),
    }));

    return [...live, ...history];
  });

  readonly groups = computed<OverlayGroup<SessionPickerItem>[]>(() => {
    const query = this.query().trim().toLowerCase();
    const items = this.items()
      .filter((item) => this.matches(item, query))
      .sort((left, right) => this.score(right) - this.score(left) || left.title.localeCompare(right.title))
      .map((item) => this.toOverlayItem(item));

    const live = items.filter((item) => item.value.kind === 'live');
    const history = items.filter((item) => item.value.kind === 'history');
    const archived = items.filter((item) => item.value.kind === 'archived');

    return [
      { id: 'live', label: 'Live Sessions', items: live },
      { id: 'history', label: 'History', items: history },
      { id: 'archived', label: 'Archived', items: archived },
    ];
  });

  setQuery(query: string): void {
    this.query.set(query);
  }

  async run(item: OverlayItem<SessionPickerItem>): Promise<boolean> {
    const session = item.value;
    await this.usageStore.record('session', session.id, session.projectPath);

    if (session.kind === 'live') {
      this.instanceStore.setSelectedInstance(session.id);
      return true;
    }

    const result = await this.historyStore.restoreEntry(session.id, session.projectPath);
    if (result.success && result.instanceId) {
      this.instanceStore.setSelectedInstance(result.instanceId);
      return true;
    }

    return false;
  }

  private toOverlayItem(item: SessionPickerItem): OverlayItem<SessionPickerItem> {
    return {
      id: `${item.kind}:${item.id}`,
      label: item.title,
      description: item.subtitle,
      detail: item.projectPath,
      badge: item.kind === 'live' ? 'Live' : item.kind === 'history' ? 'History' : 'Archived',
      keywords: [item.title, item.subtitle ?? '', item.projectPath ?? '', item.provider ?? ''],
      value: item,
    };
  }

  private matches(item: SessionPickerItem, query: string): boolean {
    if (!query) return true;
    return [
      item.title,
      item.subtitle ?? '',
      item.projectPath ?? '',
      item.provider ?? '',
      item.kind,
    ].some((value) => value.toLowerCase().includes(query));
  }

  private score(item: SessionPickerItem): number {
    const liveBoost = item.kind === 'live' ? 10_000 : 0;
    const recent = item.lastActivity ? item.lastActivity / 1_000_000 : 0;
    return liveBoost + item.frecencyScore * 1000 + recent;
  }
}
