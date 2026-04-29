import { Injectable, computed, inject, signal } from '@angular/core';
import type { HistoryRestoreResult } from '../../../../shared/types/history.types';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { UsageStore } from '../../core/state/usage.store';
import type { OverlayController, OverlayGroup, OverlayItem } from '../overlay/overlay.types';
import { ResumeActionsService } from './resume-actions.service';
import type { ResumePickerAction, ResumePickerItem } from './resume-picker.types';

function formatAge(timestamp?: number): string {
  if (!timestamp) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function actionLabel(action: ResumePickerAction): string {
  switch (action) {
    case 'resumeLatest':
      return 'Latest';
    case 'resumeById':
      return 'Resume';
    case 'switchToLive':
      return 'Live';
    case 'forkNew':
      return 'Fork';
    case 'restoreFromFallback':
      return 'Fallback';
  }
}

@Injectable({ providedIn: 'root' })
export class ResumePickerController implements OverlayController<ResumePickerItem> {
  private readonly instanceStore = inject(InstanceStore);
  private readonly historyStore = inject(HistoryStore);
  private readonly usageStore = inject(UsageStore);
  private readonly actions = inject(ResumeActionsService);

  readonly title = 'Resume';
  readonly placeholder = 'Search resumable sessions...';
  readonly emptyLabel = 'No resumable sessions found';
  readonly query = signal('');
  readonly lastError = signal<string | null>(null);
  readonly actionLabel = actionLabel;

  private readonly items = computed<ResumePickerItem[]>(() => {
    const selected = this.instanceStore.selectedInstance();
    const latest: ResumePickerItem = {
      id: 'latest',
      kind: 'latest',
      title: 'Resume latest',
      subtitle: selected?.workingDirectory ? selected.workingDirectory : 'Most recent archived thread',
      projectPath: selected?.workingDirectory,
      lastActivity: Date.now(),
      availableActions: ['resumeLatest'],
      frecencyScore: this.usageStore.frecency('resume', 'latest'),
    };

    const live = this.instanceStore.instances().map((instance): ResumePickerItem => ({
      id: instance.id,
      kind: 'live',
      title: instance.displayName || instance.sessionId || instance.id,
      subtitle: [
        instance.provider,
        instance.currentModel,
        instance.workingDirectory,
        formatAge(instance.lastActivity),
      ].filter(Boolean).join(' · '),
      projectPath: instance.workingDirectory,
      provider: instance.provider,
      lastActivity: instance.lastActivity,
      availableActions: ['switchToLive'],
      instance,
      frecencyScore: this.usageStore.frecency('resume', instance.id),
    }));

    const history = this.historyStore.entries().map((entry): ResumePickerItem => {
      const nativeFailed = entry.nativeResumeFailedAt != null;
      return {
        id: entry.id,
        kind: entry.archivedAt ? 'archived' : 'history',
        title: entry.displayName || entry.firstUserMessage || entry.sessionId,
        subtitle: [
          entry.provider,
          entry.workingDirectory,
          formatAge(entry.endedAt || entry.createdAt),
        ].filter(Boolean).join(' · '),
        projectPath: entry.workingDirectory,
        provider: entry.provider,
        lastActivity: entry.endedAt || entry.createdAt,
        availableActions: nativeFailed ? ['restoreFromFallback'] : ['resumeById', 'forkNew'],
        entry,
        snippets: entry.snippets,
        nativeResumeFailedAt: entry.nativeResumeFailedAt,
        frecencyScore: this.usageStore.frecency('resume', entry.id),
      };
    });

    return [latest, ...live, ...history];
  });

  readonly groups = computed<OverlayGroup<ResumePickerItem>[]>(() => {
    const query = this.query().trim().toLowerCase();
    const items = this.items()
      .filter((item) => this.matches(item, query))
      .sort((left, right) => this.score(right) - this.score(left) || left.title.localeCompare(right.title))
      .map((item) => this.toOverlayItem(item));

    return [
      { id: 'quick', label: 'Quick Resume', items: items.filter(item => item.value.kind === 'latest') },
      { id: 'live', label: 'Live Sessions', items: items.filter(item => item.value.kind === 'live') },
      { id: 'history', label: 'History', items: items.filter(item => item.value.kind === 'history') },
      { id: 'archived', label: 'Archived', items: items.filter(item => item.value.kind === 'archived') },
    ];
  });

  setQuery(query: string): void {
    this.query.set(query);
  }

  run(item: OverlayItem<ResumePickerItem>): Promise<boolean> {
    return this.executeAction(item.value, item.value.availableActions[0]);
  }

  async executeAction(item: ResumePickerItem, action: ResumePickerAction | undefined): Promise<boolean> {
    if (!action) return false;

    this.lastError.set(null);
    const response = await this.invokeAction(item, action);
    if (response.success && response.data?.instanceId) {
      await this.usageStore.record('resume', item.id, item.projectPath);
      this.instanceStore.setSelectedInstance(response.data.instanceId);
      return true;
    }

    this.lastError.set(response.error?.message || 'Resume action failed');
    return false;
  }

  private invokeAction(
    item: ResumePickerItem,
    action: ResumePickerAction,
  ): Promise<{ success: boolean; data?: HistoryRestoreResult; error?: { message: string } }> {
    switch (action) {
      case 'resumeLatest':
        return this.actions.resumeLatest(item.projectPath);
      case 'resumeById':
        return this.actions.resumeById(item.id);
      case 'switchToLive':
        return this.actions.switchToLive(item.id);
      case 'forkNew':
        return this.actions.forkNew(item.id);
      case 'restoreFromFallback':
        return this.actions.restoreFromFallback(item.id);
    }
  }

  private toOverlayItem(item: ResumePickerItem): OverlayItem<ResumePickerItem> {
    const disabled = item.availableActions.length === 0;
    return {
      id: `${item.kind}:${item.id}`,
      label: item.title,
      description: item.subtitle,
      detail: item.projectPath,
      badge: item.kind === 'live' ? 'Live' : item.kind === 'latest' ? 'Latest' : item.nativeResumeFailedAt ? 'Fallback' : 'History',
      disabled,
      disabledReason: disabled ? 'No resume action available' : undefined,
      keywords: [
        item.title,
        item.subtitle,
        item.projectPath ?? '',
        item.provider ?? '',
        item.snippets?.map(snippet => snippet.excerpt).join(' ') ?? '',
      ],
      value: item,
    };
  }

  private matches(item: ResumePickerItem, query: string): boolean {
    if (!query) return true;
    return [
      item.title,
      item.subtitle,
      item.projectPath ?? '',
      item.provider ?? '',
      item.kind,
      item.snippets?.map(snippet => snippet.excerpt).join(' ') ?? '',
    ].some((value) => value.toLowerCase().includes(query));
  }

  private score(item: ResumePickerItem): number {
    const quickBoost = item.kind === 'latest' ? 20_000 : 0;
    const liveBoost = item.kind === 'live' ? 10_000 : 0;
    const recent = item.lastActivity ? item.lastActivity / 1_000_000 : 0;
    return quickBoost + liveBoost + (item.frecencyScore ?? 0) * 1000 + recent;
  }
}
