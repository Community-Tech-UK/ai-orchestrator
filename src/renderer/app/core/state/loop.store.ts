import { computed, Injectable, signal, inject } from '@angular/core';
import type {
  LoopRunSummaryPayload,
  LoopStatePayload,
} from '@contracts/schemas/loop';
import { LoopIpcService, type LoopStartConfigInput } from '../services/ipc/loop-ipc.service';

/**
 * One active loop per chat in v1. The store holds:
 *  - per-chat active loop state (or undefined)
 *  - latest no-progress / claimed-done-but-failed banner per chat
 *  - latest completion summary per chat (for the summary card)
 */

export interface LoopBannerNoProgress {
  kind: 'no-progress';
  loopRunId: string;
  signalId: string;
  message: string;
  shownAt: number;
}

export interface LoopBannerClaimedFailed {
  kind: 'claimed-failed';
  loopRunId: string;
  signal: string;
  failure: string;
  shownAt: number;
}

export type LoopBanner = LoopBannerNoProgress | LoopBannerClaimedFailed;

export interface LoopFinalSummary {
  loopRunId: string;
  status: 'completed' | 'cancelled' | 'cap-reached' | 'error' | 'no-progress';
  reason: string;
  iterations: number;
  tokens: number;
  costCents: number;
  startedAt: number;
  endedAt: number;
}

@Injectable({ providedIn: 'root' })
export class LoopStore {
  private ipc = inject(LoopIpcService);

  /** Map of chatId → active loop state. */
  private activeByChat = signal<Map<string, LoopStatePayload>>(new Map());
  /** Map of chatId → banner. */
  private bannerByChat = signal<Map<string, LoopBanner | null>>(new Map());
  /** Map of chatId → final summary card. */
  private summaryByChat = signal<Map<string, LoopFinalSummary | null>>(new Map());
  /** Map of chatId → recent runs list (for history view if shown). */
  private runsByChat = signal<Map<string, LoopRunSummaryPayload[]>>(new Map());

  private wired = false;

  // ────── public selectors ──────

  activeForChat = (chatId: string) =>
    computed(() => this.activeByChat().get(chatId));

  bannerForChat = (chatId: string) =>
    computed(() => this.bannerByChat().get(chatId) ?? null);

  summaryForChat = (chatId: string) =>
    computed(() => this.summaryByChat().get(chatId) ?? null);

  runsForChat = (chatId: string) =>
    computed(() => this.runsByChat().get(chatId) ?? []);

  isRunningForChat = (chatId: string) =>
    computed(() => {
      const a = this.activeByChat().get(chatId);
      return !!a && (a.status === 'running' || a.status === 'paused');
    });

  // ────── lifecycle ──────

  /**
   * Wire IPC listeners once at app startup. Safe to call multiple times.
   */
  ensureWired(): void {
    if (this.wired) return;
    this.wired = true;

    this.ipc.onStateChanged(({ state }) => {
      if (state.status === 'completed' || state.status === 'cancelled' || state.status === 'cap-reached' || state.status === 'error' || state.status === 'no-progress') {
        // record final summary, clear active
        this.upsertSummary(state.chatId, {
          loopRunId: state.id,
          status: state.status as LoopFinalSummary['status'],
          reason: state.endReason ?? state.status,
          iterations: state.totalIterations,
          tokens: state.totalTokens,
          costCents: state.totalCostCents,
          startedAt: state.startedAt,
          endedAt: state.endedAt ?? Date.now(),
        });
        this.clearActive(state.chatId);
      } else {
        this.upsertActive(state);
        // if we re-entered a non-terminal state, clear any banner (the no-progress
        // banner stays until user resumes/cancels — leave it).
      }
    });

    this.ipc.onPausedNoProgress(({ loopRunId, signal }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (!chatId) return;
      this.setBanner(chatId, {
        kind: 'no-progress',
        loopRunId,
        signalId: signal.id,
        message: signal.message,
        shownAt: Date.now(),
      });
    });

    this.ipc.onClaimedDoneButFailed(({ loopRunId, signal, failure }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (!chatId) return;
      this.setBanner(chatId, {
        kind: 'claimed-failed',
        loopRunId,
        signal,
        failure,
        shownAt: Date.now(),
      });
    });

    this.ipc.onCompleted(({ loopRunId }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (chatId) this.setBanner(chatId, null);
    });

    this.ipc.onCapReached(({ loopRunId }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (chatId) this.setBanner(chatId, null);
    });

    this.ipc.onError(({ loopRunId }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (!chatId) return;
      this.setBanner(chatId, null);
    });
  }

  // ────── commands ──────

  /** Set of chatIds with a start-IPC currently in flight. Prevents the
   *  store from issuing two LOOP_START requests for the same chat — the
   *  main process also enforces this, but failing fast in the renderer
   *  saves a round-trip and makes the error message obvious. */
  private startingByChat = new Set<string>();

  async start(
    chatId: string,
    config: LoopStartConfigInput,
    attachments?: { name: string; data: Uint8Array }[],
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.startingByChat.has(chatId)) {
      return { ok: false, error: 'A loop is already starting for this chat — please wait.' };
    }
    if (this.activeByChat().has(chatId)) {
      return { ok: false, error: 'A loop is already active for this chat — cancel it first.' };
    }
    this.startingByChat.add(chatId);
    try {
      const r = await this.ipc.start(chatId, config, attachments);
      if (!r.success) return { ok: false, error: r.error?.message ?? 'unknown error' };
      if (r.data?.state) this.upsertActive(r.data.state);
      return { ok: true };
    } finally {
      this.startingByChat.delete(chatId);
    }
  }

  async pause(loopRunId: string): Promise<void> { await this.ipc.pause(loopRunId); }
  async resume(loopRunId: string): Promise<void> {
    const chatId = this.findChatIdForLoop(loopRunId);
    if (chatId) this.setBanner(chatId, null);
    await this.ipc.resume(loopRunId);
  }
  async intervene(loopRunId: string, message: string): Promise<void> { await this.ipc.intervene(loopRunId, message); }
  async cancel(loopRunId: string): Promise<void> { await this.ipc.cancel(loopRunId); }

  async refreshHistory(chatId: string, limit = 25): Promise<void> {
    const r = await this.ipc.listRunsForChat(chatId, limit);
    if (r.success && r.data?.runs) {
      const map = new Map(this.runsByChat());
      map.set(chatId, r.data.runs);
      this.runsByChat.set(map);
    }
  }

  dismissSummary(chatId: string): void {
    const map = new Map(this.summaryByChat());
    map.set(chatId, null);
    this.summaryByChat.set(map);
  }

  dismissBanner(chatId: string): void {
    this.setBanner(chatId, null);
  }

  // ────── private mutators ──────

  private upsertActive(state: LoopStatePayload): void {
    const map = new Map(this.activeByChat());
    map.set(state.chatId, state);
    this.activeByChat.set(map);
  }

  private clearActive(chatId: string): void {
    const map = new Map(this.activeByChat());
    map.delete(chatId);
    this.activeByChat.set(map);
  }

  private upsertSummary(chatId: string, summary: LoopFinalSummary): void {
    const map = new Map(this.summaryByChat());
    map.set(chatId, summary);
    this.summaryByChat.set(map);
  }

  private setBanner(chatId: string, banner: LoopBanner | null): void {
    const map = new Map(this.bannerByChat());
    map.set(chatId, banner);
    this.bannerByChat.set(map);
  }

  private findChatIdForLoop(loopRunId: string): string | null {
    for (const [chatId, state] of this.activeByChat()) {
      if (state.id === loopRunId) return chatId;
    }
    return null;
  }
}
