import { Injectable, computed, inject, signal } from '@angular/core';
import { matchesOverlayQuery } from '../../shared/utils/overlay-search';
import type { SessionRecoveryCandidate, SessionRecoveryReason } from '../../../../shared/types/session-recovery.types';
import { ToastService } from '../../core/services/toast.service';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SessionRecoveryStore } from '../../core/state/session-recovery.store';
import { UsageStore } from '../../core/state/usage.store';
import type { OverlayController, OverlayGroup, OverlayItem } from '../overlay/overlay.types';
import { ResumeActionsService, type ResumeActionResponse } from './resume-actions.service';
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
    case 'recoverAutosave':
      return 'Recover';
  }
}

function recoveryReasonLabel(reason: SessionRecoveryReason): string {
  switch (reason) {
    case 'newer-than-history':
      return 'Newer than history';
    case 'unarchived':
      return 'Not in history';
    case 'draft-only':
      return 'Draft only';
  }

  const exhaustive: never = reason;
  return exhaustive;
}

function messageCountLabel(count: number): string {
  return `${count} autosaved message${count === 1 ? '' : 's'}`;
}

function recoveryTitle(candidate: SessionRecoveryCandidate): string {
  return candidate.displayName
    ?? candidate.historyThreadId
    ?? candidate.sourceInstanceId;
}

function newestRecoveryCandidate(candidates: readonly SessionRecoveryCandidate[]): SessionRecoveryCandidate | null {
  return [...candidates].sort((left, right) =>
    right.lastActivityAt - left.lastActivityAt || left.recoveryKey.localeCompare(right.recoveryKey)
  )[0] ?? null;
}

@Injectable({ providedIn: 'root' })
export class ResumePickerController implements OverlayController<ResumePickerItem> {
  private readonly instanceStore = inject(InstanceStore);
  private readonly historyStore = inject(HistoryStore);
  private readonly recoveryStore = inject(SessionRecoveryStore);
  private readonly usageStore = inject(UsageStore);
  private readonly actions = inject(ResumeActionsService);
  private readonly toast = inject(ToastService);

  readonly title = 'Resume';
  readonly placeholder = 'Search resumable sessions...';
  readonly emptyLabel = 'No resumable sessions found';
  readonly query = signal('');
  readonly lastError = signal<string | null>(null);
  readonly actionLabel = actionLabel;

  private readonly latestRecoveryCandidate = computed(() =>
    newestRecoveryCandidate(this.recoveryStore.candidates())
  );

  private readonly items = computed<ResumePickerItem[]>(() => {
    const selected = this.instanceStore.selectedInstance();
    const latestRecovery = this.latestRecoveryCandidate();
    const latest: ResumePickerItem = {
      id: 'latest',
      kind: 'latest',
      title: 'Resume latest',
      subtitle: latestRecovery
        ? `Autosave recovery · ${recoveryTitle(latestRecovery)} · ${formatAge(latestRecovery.lastActivityAt)}`
        : selected?.workingDirectory ? selected.workingDirectory : 'Most recent archived thread',
      projectPath: latestRecovery?.workingDirectory ?? selected?.workingDirectory,
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

    const recovery = this.recoveryStore.candidates().map((candidate): ResumePickerItem => ({
      id: candidate.recoveryKey,
      kind: 'recovery',
      title: recoveryTitle(candidate),
      subtitle: [
        candidate.provider,
        candidate.modelId,
        candidate.workingDirectory,
        recoveryReasonLabel(candidate.reason),
        messageCountLabel(candidate.recoveredMessageCount),
        formatAge(candidate.lastActivityAt),
      ].filter(Boolean).join(' · '),
      projectPath: candidate.workingDirectory,
      provider: candidate.provider,
      lastActivity: candidate.lastActivityAt,
      availableActions: ['recoverAutosave'],
      recoveryCandidate: candidate,
      frecencyScore: this.usageStore.frecency('resume', candidate.recoveryKey),
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

    return [latest, ...live, ...recovery, ...history];
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
      { id: 'recovery', label: 'Autosave recovery', items: items.filter(item => item.value.kind === 'recovery') },
      { id: 'history', label: 'History', items: items.filter(item => item.value.kind === 'history') },
      { id: 'archived', label: 'Archived', items: items.filter(item => item.value.kind === 'archived') },
    ];
  });

  setQuery(query: string): void {
    this.query.set(query);
  }

  focusRecoveryContent(): void {
    this.query.set('autosave');
  }

  resetTransientFocus(): void {
    this.query.set('');
  }

  run(item: OverlayItem<ResumePickerItem>): Promise<boolean> {
    return this.executeAction(item.value, item.value.availableActions[0]);
  }

  async executeAction(item: ResumePickerItem, action: ResumePickerAction | undefined): Promise<boolean> {
    if (!action) return false;

    this.lastError.set(null);
    const response = await this.invokeAction(item, action);
    if (response.success && response.data?.instanceId) {
      this.instanceStore.setSelectedInstance(response.data.instanceId);
      if (response.source === 'recovery') {
        await Promise.allSettled([
          this.historyStore.loadHistory(),
          this.instanceStore.refreshInstances(),
        ]);
        const count = response.recoveredMessageCount
          ?? item.recoveryCandidate?.recoveredMessageCount
          ?? 0;
        this.toast.show(`Recovered ${messageCountLabel(count)}.`, 'success');
      }
      await this.recordUsage(item);
      return true;
    }

    this.lastError.set(response.error?.message || 'Resume action failed');
    return false;
  }

  actionAriaLabel(item: ResumePickerItem, action: ResumePickerAction): string {
    if (action === 'recoverAutosave') {
      return `Recover autosaved session ${item.title}`;
    }

    return `${actionLabel(action)} ${item.title}`;
  }

  actionProgressLabel(action: ResumePickerAction): string {
    if (action === 'recoverAutosave') {
      return 'Recovering...';
    }

    return actionLabel(action);
  }

  isActionLoading(item: ResumePickerItem, action: ResumePickerAction): boolean {
    const recoveringKey = this.recoveryStore.recoveringKey();
    if (!recoveringKey) {
      return false;
    }

    if (action === 'resumeLatest') {
      return this.latestRecoveryCandidate()?.recoveryKey === recoveringKey;
    }

    if (action === 'recoverAutosave') {
      return (item.recoveryCandidate?.recoveryKey ?? item.id) === recoveringKey;
    }

    return false;
  }

  private invokeAction(
    item: ResumePickerItem,
    action: ResumePickerAction,
  ): Promise<ResumeActionResponse> {
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
      case 'recoverAutosave':
        return this.actions.recoverAutosave(item.recoveryCandidate?.recoveryKey ?? item.id);
    }
  }

  private async recordUsage(item: ResumePickerItem): Promise<void> {
    try {
      await this.usageStore.record('resume', item.id, item.projectPath);
    } catch {
      // Usage bookkeeping is best-effort. Resume/recovery success is already
      // authoritative by this point and must not be turned into UI failure.
    }
  }

  private toOverlayItem(item: ResumePickerItem): OverlayItem<ResumePickerItem> {
    const recoveryInProgress = this.recoveryStore.recoveringKey() !== null;
    const hasNoActions = item.availableActions.length === 0;
    const disabled = hasNoActions || recoveryInProgress;
    return {
      id: `${item.kind}:${item.id}`,
      label: item.title,
      description: item.subtitle,
      detail: item.projectPath,
      badge:
        item.kind === 'live'
          ? 'Live'
          : item.kind === 'latest'
            ? 'Latest'
            : item.kind === 'recovery'
              ? 'Autosave'
              : item.nativeResumeFailedAt
                ? 'Fallback'
                : 'History',
      disabled,
      disabledReason: hasNoActions
        ? 'No resume action available'
        : recoveryInProgress
          ? 'Recovery in progress'
          : undefined,
      activationMode: 'manual',
      keywords: [
        item.title,
        item.subtitle,
        item.projectPath ?? '',
        item.provider ?? '',
        item.kind === 'recovery' ? 'autosave recovery' : '',
        item.recoveryCandidate?.reason ?? '',
        item.recoveryCandidate ? messageCountLabel(item.recoveryCandidate.recoveredMessageCount) : '',
        item.snippets?.map(snippet => snippet.excerpt).join(' ') ?? '',
      ],
      value: item,
    };
  }

  private matches(item: ResumePickerItem, query: string): boolean {
    return matchesOverlayQuery([
      item.title,
      item.subtitle,
      item.projectPath ?? '',
      item.provider ?? '',
      item.kind,
      item.kind === 'recovery' ? 'autosave recovery' : '',
      item.recoveryCandidate?.reason ?? '',
      item.recoveryCandidate ? messageCountLabel(item.recoveryCandidate.recoveredMessageCount) : '',
      item.snippets?.map(snippet => snippet.excerpt).join(' ') ?? '',
    ], query);
  }

  private score(item: ResumePickerItem): number {
    const quickBoost = item.kind === 'latest' ? 20_000 : 0;
    const liveBoost = item.kind === 'live' ? 10_000 : 0;
    const recoveryBoost = item.kind === 'recovery' ? 5_000 : 0;
    const recent = item.lastActivity ? item.lastActivity / 1_000_000 : 0;
    return quickBoost + liveBoost + recoveryBoost + (item.frecencyScore ?? 0) * 1000 + recent;
  }
}
