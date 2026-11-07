import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { LoopOutstandingItemPayload } from '@contracts/schemas/loop';
import { sortNeedsYou, NEEDS_YOU_RECENCY_MS, type NeedsYouEntry } from '../../../../shared/attention/needs-you';
import type { AttentionLevel } from '../../../../shared/attention/attention-level';
import { InstanceStore } from '../../core/state/instance.store';
import { LoopStore } from '../../core/state/loop.store';
import { AutomationStore } from '../../core/state/automation.store';
import { RepoJobStore } from '../../core/state/repo-job.store';
import { PermissionApprovalsStore } from '../../core/state/permission-approvals.store';
import { BrowserApprovalsStore } from '../../core/state/browser-approvals.store';
import { PlanQueueStore } from '../../core/state/plan-queue.store';
import { PendingRequestStore } from '../../core/state/pending-request.store';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { DocReviewStore } from '../doc-review/doc-review.store';
import { MemoryReviewStore } from '../memory-review/memory-review.store';
import { loopPauseReason } from '../loop/loop-formatters.util';
import { correlateWorkboard, retainWorkboardItems, snoozeClearedByAttention } from './workboard-projection';
import { requestEntries, workboardEntry, workboardEntryKey } from './needs-you-sources';
import type { WorkboardProjectionInput } from './workboard.types';

const SEEN_KEY = 'harness.needs-you.seen.v1';
interface Seen { version: string; at: number }

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** The one app-wide attention projection. No page needs to be mounted to count. */
@Injectable({ providedIn: 'root' })
export class NeedsYouStore {
  private readonly instances = inject(InstanceStore);
  private readonly loops = inject(LoopStore);
  private readonly automations = inject(AutomationStore);
  private readonly repos = inject(RepoJobStore);
  private readonly permissions = inject(PermissionApprovalsStore);
  private readonly browsers = inject(BrowserApprovalsStore);
  private readonly plans = inject(PlanQueueStore);
  private readonly documents = inject(DocReviewStore);
  private readonly memories = inject(MemoryReviewStore);
  private readonly guard = inject(LocalAiGuardStore);
  private readonly sidechats = inject(SideChatStore);
  private readonly tools = inject(ToolLoopAlertStore);
  private readonly pending = inject(PendingRequestStore);
  private readonly loopIpc = inject(LoopIpcService);
  private readonly ipc = inject(ElectronIpcService);
  private readonly destroy = inject(DestroyRef);
  private readonly now = signal(Date.now());
  private readonly outstandingSignal = signal<LoopOutstandingItemPayload[]>([]);
  private readonly seen = signal<ReadonlyMap<string, Seen>>(readSeen());
  private readonly snoozed = signal<ReadonlyMap<string, AttentionLevel>>(new Map());
  private readonly activeSeen = computed(() => {
    const cutoff = this.now() - NEEDS_YOU_RECENCY_MS;
    return new Map([...this.seen()].filter(([, item]) => item.at >= cutoff));
  }, { equal: (a, b) => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value) });
  private readonly activePermissions = computed(() => {
    const now = this.now();
    return this.permissions.pendingRequests().filter(item => item.expiresAt > now);
  }, { equal: sameItems });
  private readonly activeBrowsers = computed(() => {
    const now = this.now();
    return this.browsers.pendingRequests().filter(item => item.expiresAt > now);
  }, { equal: sameItems });
  private readonly activeFallbacks = computed(() => {
    const now = this.now();
    return this.guard.pendingFallbacks().filter(item => item.expiresAt > now);
  }, { equal: sameItems });
  private readonly activeDocuments = computed(() => {
    const now = this.now();
    return this.documents.sessions().filter(item => item.status === 'pending'
      && item.createdAt >= now - NEEDS_YOU_RECENCY_MS && item.createdAt <= now);
  }, { equal: sameItems });
  private initialized = false;
  private outstandingGeneration = 0;
  private outstandingRefreshFailed = false;
  readonly outstanding = this.outstandingSignal.asReadonly();

  private readonly narrowInstances = computed(() => this.instances.instances().map((item) => ({
    id: item.id, status: item.status, pendingApprovalCount: item.pendingApprovalCount,
    displayName: item.displayName, lastActivity: item.lastActivity, parentId: item.parentId,
    workingDirectory: item.workingDirectory, provider: item.provider,
  })), { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) });

  readonly pausedForYou = computed(() => {
    const result = new Map<string, 'sign-off' | 'blocked' | 'step-failed' | 'stuck'>();
    for (const state of this.loops.activeStates().values()) {
      if (state.status !== 'paused') continue;
      const banner = this.loops.banners().get(state.chatId);
      const reason = loopPauseReason({ lastCompletionOutcome: state.lastCompletionOutcome,
        bannerKind: banner?.kind, bannerSignalId: banner?.kind === 'no-progress' ? banner.signalId : null });
      if (reason !== 'paused') result.set(state.id, reason === 'awaiting-review' ? 'sign-off' : reason === 'no-progress' ? 'stuck' : reason);
    }
    return result;
  });

  private readonly correlatedWorkItems = computed(() => correlateWorkboard({
    instances: this.narrowInstances(), loopRuns: this.loops.recentRuns(), automationRuns: this.automations.runs(),
    automations: this.automations.automations(), repoJobs: this.repos.jobs(), pausedForYou: this.pausedForYou(),
  } satisfies Omit<WorkboardProjectionInput, 'now'>));
  readonly workItems = computed(() => retainWorkboardItems(this.correlatedWorkItems(), this.now()), { equal: sameItems });

  private readonly rawEntries = computed(() => {
    const work = this.workItems().filter((item) => item.lane === 'needs-you').map((item) => {
      const entry = workboardEntry(item);
      const pending = entry.instanceId ? this.pending.forInstance(entry.instanceId)[0] : undefined;
      return pending ? { ...entry, detail: pending.text, since: pending.since } : entry;
    });
    const answerSessions = new Set(work.filter(entry => entry.kind === 'answer').map(entry => entry.instanceId));
    const toolLoops = [...this.tools.liveIds()].flatMap((id) => {
      // A live question already explains why the session needs an answer.
      if (answerSessions.has(id)) return [];
      const alert = this.tools.alertFor(id);
      return alert ? [alert] : [];
    });
    const requests = requestEntries({ permissions: this.activePermissions(), browsers: this.activeBrowsers(),
      fallbacks: this.activeFallbacks(), plans: this.plans.needsAnswerItems(), documents: this.activeDocuments(),
      memories: this.memories.proposals(), sidechats: this.sidechats.attentionList(),
      outstanding: this.outstandingSignal().map((item) => ({ ...item, userResponse: item.userResponse ?? null })), toolLoops,
    }, untracked(this.now));
    return sortNeedsYou([...work, ...requests]);
  });

  // An answer is never hidden by a snooze, even a stale one: a question or approval must stay in view until someone replies.
  readonly entries = computed(() => this.rawEntries().filter((entry) =>
    !this.isSeen(entry) && (entry.kind === 'answer' || !this.isSnoozed(entry.key))));
  readonly count = computed(() => this.entries().length);
  readonly answerEntries = computed(() => this.entries().filter((entry) => entry.kind === 'answer'));
  readonly sessionIds = computed(() => new Set(this.entries().filter((entry) => entry.kind !== 'applied' && entry.instanceId)
    .map((entry) => entry.instanceId!)));

  constructor() {
    effect(() => this.now.set(this.permissions.now()));
    effect(() => {
      const id = this.instances.selectedInstanceId();
      untracked(() => this.rawEntries()
        .filter((entry) => entry.kind === 'check' && entry.instanceId === id)
        .forEach((entry) => this.markSeen(entry.key)));
    });
    effect(() => {
      const snoozed = untracked(() => this.snoozed());
      // Keep the source dependency even when no snoozes need cleanup.
      const items = this.workItems();
      if (snoozed.size === 0) return;
      const next = new Map<string, AttentionLevel>();
      for (const item of items) {
        const key = workboardEntryKey(item), baseline = snoozed.get(key);
        if (baseline !== undefined && !snoozeClearedByAttention(item.attentionLevel, baseline)) next.set(key, baseline);
      }
      if (next.size !== snoozed.size) untracked(() => this.snoozed.set(next));
    });
    effect((cleanup) => {
      const count = Math.min(9999, this.count());
      const timer = setTimeout(() => {
        const api = this.ipc.getApi();
        if (api?.setAttentionBadge) void api.setAttentionBadge(count).catch(() => { /* Renderer can outlive preload. */ });
      }, 500);
      cleanup(() => clearTimeout(timer));
    });
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.loops.ensureWired(); this.plans.ensureWired(); this.permissions.startPolling();
    void this.sidechats.initialize();
    void this.loops.refreshRecentRuns(100); void this.plans.load();
    if (this.automations.runs().length === 0) void this.automations.refresh();
    void this.refreshOutstanding(); void this.repos.refresh(false); void this.memories.refresh();
    const off = this.loopIpc.onOutstandingChanged(() => void this.refreshOutstanding());
    const focus = () => { this.now.set(Date.now()); void this.refreshOutstanding(); void this.repos.refresh(false); void this.memories.refresh(); };
    window.addEventListener('focus', focus);
    const repoTimer = setInterval(() => { this.now.set(Date.now()); void this.repos.refresh(false); }, 120_000);
    const memoryTimer = setInterval(() => void this.memories.refresh(), 300_000);
    this.destroy.onDestroy(() => { off(); window.removeEventListener('focus', focus); clearInterval(repoTimer); clearInterval(memoryTimer); });
  }

  async refreshOutstanding(): Promise<void> {
    const generation = ++this.outstandingGeneration;
    try {
      const result = await this.loopIpc.listOutstanding({ status: 'open', limit: 500 });
      if (generation !== this.outstandingGeneration) return;
      if (result.success && result.data) {
        this.outstandingSignal.set(result.data.items);
        this.outstandingRefreshFailed = false;
      } else this.reportOutstandingRefreshFailure();
    } catch {
      if (generation === this.outstandingGeneration) this.reportOutstandingRefreshFailure();
    }
  }

  private reportOutstandingRefreshFailure(): void {
    if (!this.outstandingRefreshFailed) console.warn('Unable to refresh open loop items. Keeping the last successful list.');
    this.outstandingRefreshFailed = true;
  }

  isSeen(entry: NeedsYouEntry): boolean {
    const seen = this.activeSeen().get(entry.key);
    return entry.kind === 'check' && seen?.version === entry.version;
  }
  advanceClock(now = Date.now()): void { this.now.set(now); }
  markSeen(key: string): void {
    const entry = this.rawEntries().find((item) => item.key === key);
    if (!entry || entry.kind !== 'check' || this.isSeen(entry)) return;
    const next = new Map([...this.seen()].filter(([, item]) => item.at >= Date.now() - NEEDS_YOU_RECENCY_MS));
    next.set(key, { version: entry.version, at: Date.now() }); this.seen.set(next);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...next])); } catch { /* A reload safely re-shows checks. */ }
  }
  markSeenForInstance(id: string): void { this.rawEntries().filter((item) => item.instanceId === id).forEach((item) => this.markSeen(item.key)); }
  /** Puts a card away until it needs you more than it did. A blocked card is a question or approval someone is waiting on, so it never snoozes. */
  snooze(key: string): void {
    const item = this.workItems().find((item) => workboardEntryKey(item) === key);
    if (!item || item.attentionLevel === 'blocked') return;
    this.snoozed.update((current) => new Map(current).set(key, item.attentionLevel));
  }
  unsnooze(key: string): void { this.snoozed.update((current) => { const next = new Map(current); next.delete(key); return next; }); }
  isSnoozed(key: string): boolean { return this.snoozed().has(key); }
  /** How many items are snoozed right now. */
  readonly snoozedCount = computed(() => this.snoozed().size);
  clearSnoozes(): void { this.snoozed.set(new Map()); }
}

function readSeen(): ReadonlyMap<string, Seen> {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    if (!Array.isArray(rows)) return new Map();
    return new Map(rows.filter((row): row is [string, Seen] => Array.isArray(row) && row.length === 2
      && typeof row[0] === 'string' && row[1] && typeof row[1].version === 'string'
      && Number.isFinite(row[1].at) && row[1].at >= Date.now() - NEEDS_YOU_RECENCY_MS));
  } catch { return new Map(); }
}
