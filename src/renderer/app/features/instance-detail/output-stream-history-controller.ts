import { signal } from '@angular/core';
import type { OutputMessage } from '../../core/state/instance.store';
import type { InstanceIpcService } from '../../core/services/ipc';
import type { InstanceOutputStore } from '../../core/state/instance/instance-output.store';
import type { DisplayItem } from './display-item.types';
import { revealOlderHistory } from './output-stream-history-reveal';
import { runRestoreFrame } from './restore-frame';

export interface OlderMessagesLoadResult {
  prependedCount: number;
  hasMore: boolean;
  totalStored: number;
}

export interface OlderMessagesProbeResult { hasMore: boolean; totalStored: number }

export interface OutputStreamHistoryDeps {
  getInstanceId: () => string;
  getMessages: () => OutputMessage[];
  getOlderMessagesLoader: () => (() => Promise<OlderMessagesLoadResult | null>) | null;
  getOlderMessagesProbe: () => (() => Promise<OlderMessagesProbeResult | null>) | null;
  getViewportElement: () => HTMLElement | null;
  hiddenRenderedCount: () => number;
  windowedItems: () => readonly DisplayItem[];
  growRenderWindow: (instanceId: string, by: number) => void;
  resetRenderWindow: (instanceId: string) => void;
  instanceIpc: Pick<InstanceIpcService, 'loadOlderMessages'>;
  outputStore: Pick<InstanceOutputStore, 'prependOlderMessages' | 'releaseLoadedHistory'>;
}

/** Disk page size for scroll-edge loads. */
const SCROLL_PAGE_LIMIT = 200;
/** Disk page size for whole-history walks (the IPC schema's maximum). */
const HISTORY_WALK_PAGE_LIMIT = 500;
/** How close to the bottom counts as reading the live tail (matches the scroll listener). */
const LIVE_TAIL_THRESHOLD_PX = 100;
/**
 * How long the viewport must stay at the live tail before loaded history is
 * released. A jump that starts from the bottom (rail click, scroll to top)
 * passes through it; releasing on that first scroll event trimmed away the
 * history the jump was heading for.
 */
const RELEASE_SETTLE_MS = 1_000;

const nextRenderedFrame = (): Promise<void> => new Promise((resolve) => runRestoreFrame(resolve));

/**
 * Extracted from OutputStreamComponent (see `check:ts-max-loc`). Owns the
 * transcript's older-history state: the has-more probe, disk paging by stored
 * message offset (or a host's custom loader), whole-history walks for "Scroll
 * to top" and jump-rail clicks, and handing loaded history back to the
 * buffer cap once the user is done with it.
 */
export class OutputStreamHistoryController {
  readonly isLoadingOlder = signal(false);
  /** Hidden until the backend confirms a stored transcript exists. */
  readonly hasOlderMessages = signal(false);
  /** Stored messages not in the loaded window — the display's history offset. */
  readonly hiddenMessageCount = signal(0);

  /** instanceId -> stored-message offset of the oldest page loaded (disk paging cursor). */
  private readonly oldestOffsetLoaded = new Map<string, number>();
  private olderLoadInFlight: Promise<void> | null = null;
  /** History walks run one at a time; the count guards history release. */
  private revealChain: Promise<unknown> = Promise.resolve();
  private activeReveals = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: OutputStreamHistoryDeps) {}

  /** Instance switch: release the outgoing session's history, reset state, probe the new one. */
  switchInstance(previousInstanceId: string | null, instanceId: string): void {
    this.cancelPendingRelease();
    if (previousInstanceId !== null) this.releaseLoadedHistory(previousInstanceId);
    this.olderLoadInFlight = null;
    this.hasOlderMessages.set(false);
    this.isLoadingOlder.set(false);
    this.hiddenMessageCount.set(0);
    void this.probe(instanceId);
  }

  /**
   * Scroll listener hook: the viewport reached the live tail. Release loaded
   * history once it has settled there, not while a walk or jump is moving.
   */
  onViewportAtBottom(): void {
    this.cancelPendingRelease();
    const instanceId = this.deps.getInstanceId();
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      const viewport = this.deps.getViewportElement();
      if (
        this.deps.getInstanceId() !== instanceId
        || this.activeReveals > 0
        || this.isLoadingOlder()
        || !viewport
        || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > LIVE_TAIL_THRESHOLD_PX
      ) {
        return;
      }
      this.releaseLoadedHistory(instanceId);
    }, RELEASE_SETTLE_MS);
  }

  /** Component teardown. */
  destroy(): void {
    this.cancelPendingRelease();
  }

  private cancelPendingRelease(): void {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  /**
   * Hand history the user loaded back to the buffer cap (see
   * InstanceOutputStore.releaseLoadedHistory). When that trims it, the disk
   * cursor restarts from the newest stored page so the next scroll-up
   * reloads what was dropped instead of skipping past it.
   */
  releaseLoadedHistory(instanceId: string): void {
    const dropped = this.deps.outputStore.releaseLoadedHistory(instanceId);
    if (dropped === 0) return;
    this.oldestOffsetLoaded.delete(instanceId);
    this.deps.resetRenderWindow(instanceId);
    if (instanceId === this.deps.getInstanceId()) {
      this.hasOlderMessages.set(true);
      this.hiddenMessageCount.update((count) => count + dropped);
    }
  }

  /** Reveal every hidden item and stored page back to the session's start. */
  revealAll(): Promise<void> {
    return this.revealHistory(() => false);
  }

  /** Jump-rail hook: reveal older history until this user prompt renders. */
  readonly revealUntilMessage = (messageId: string): Promise<void> =>
    this.revealHistory(() =>
      this.deps.windowedItems().some((item) => item.type === 'message' && item.message?.id === messageId),
    );

  /**
   * Reveal older history until `done()` holds or the session's start is
   * rendered. Walks are serialised so a rail click during "Scroll to top"
   * waits its turn instead of misreading a half-loaded transcript.
   */
  private revealHistory(done: () => boolean): Promise<void> {
    const run = this.revealChain.then(async () => {
      const instanceId = this.deps.getInstanceId();
      this.activeReveals++;
      try {
        await revealOlderHistory({
          done,
          isStale: () => this.deps.getInstanceId() !== instanceId,
          hiddenRenderedCount: () => this.deps.hiddenRenderedCount(),
          revealAllRendered: () => this.deps.growRenderWindow(instanceId, this.deps.hiddenRenderedCount()),
          hasOlderMessages: () => this.hasOlderMessages(),
          loadOlderMessages: () => this.loadOlderMessages(HISTORY_WALK_PAGE_LIMIT),
          progressKey: () => [
            this.deps.getMessages().length,
            this.deps.hiddenRenderedCount(),
            this.oldestOffsetLoaded.get(instanceId) ?? '',
            this.hasOlderMessages(),
          ].join('|'),
          afterStep: nextRenderedFrame,
        });
      } finally {
        this.activeReveals--;
      }
    });
    this.revealChain = run.catch(() => undefined);
    return run;
  }

  /** Load the next older page from disk storage (or the host's loader). */
  loadOlderMessages(limit = SCROLL_PAGE_LIMIT): Promise<void> {
    // Join a load already in flight rather than no-op, so callers that await
    // it (history walks, transcript find) see its result.
    if (this.olderLoadInFlight) return this.olderLoadInFlight;
    if (this.isLoadingOlder() || !this.hasOlderMessages()) return Promise.resolve();
    const load = this.fetchOlderPage(limit).finally(() => {
      if (this.olderLoadInFlight === load) this.olderLoadInFlight = null;
    });
    this.olderLoadInFlight = load;
    return load;
  }

  private async fetchOlderPage(limit: number): Promise<void> {
    const instanceId = this.deps.getInstanceId();
    const isCurrent = (): boolean => this.deps.getInstanceId() === instanceId;
    this.isLoadingOlder.set(true);

    try {
      const customLoader = this.deps.getOlderMessagesLoader();
      if (customLoader) {
        const viewport = this.deps.getViewportElement();
        const scrollHeightBefore = viewport?.scrollHeight ?? 0;
        const data = await customLoader();
        if (!isCurrent()) return;
        if (data) {
          this.hasOlderMessages.set(data.hasMore);
          this.hiddenMessageCount.set(Math.max(0, data.totalStored - this.deps.getMessages().length));
          if (data.prependedCount > 0) {
            // Newly loaded pages must actually enter the DOM: grow the render
            // window by at least the prepended item count.
            this.deps.growRenderWindow(instanceId, data.prependedCount);
            this.restoreScrollAfterPrepend(viewport, scrollHeightBefore);
          }
        } else {
          this.hasOlderMessages.set(false);
        }
        return;
      }

      const result = await this.deps.instanceIpc.loadOlderMessages(instanceId, {
        beforeOffset: this.oldestOffsetLoaded.get(instanceId),
        limit,
      });
      // Switched sessions mid-request: this page belongs to the old one.
      if (!isCurrent()) return;

      if (result.success && result.data) {
        const data = result.data as {
          messages: OutputMessage[];
          hasMore: boolean;
          oldestOffsetLoaded?: number;
          totalStored: number;
        };

        if (data.messages.length > 0) {
          const existingIds = new Set(this.deps.getMessages().map(message => message.id));
          const prependedCount = data.messages.filter(message => !existingIds.has(message.id)).length;

          // Remember scroll height before prepend to maintain position
          const viewport = this.deps.getViewportElement();
          const scrollHeightBefore = viewport?.scrollHeight ?? 0;

          this.deps.outputStore.prependOlderMessages(instanceId, data.messages);
          if (prependedCount > 0) {
            this.hiddenMessageCount.update((count) => Math.max(0, count - prependedCount));
            this.deps.growRenderWindow(instanceId, prependedCount);
          }
          this.restoreScrollAfterPrepend(viewport, scrollHeightBefore);
        }

        this.hasOlderMessages.set(data.hasMore);
        if (data.oldestOffsetLoaded !== undefined) {
          this.oldestOffsetLoaded.set(instanceId, data.oldestOffsetLoaded);
        }
      } else {
        this.hasOlderMessages.set(false);
      }
    } catch (error) {
      console.error('[OutputStream] Failed to load older messages:', error);
    } finally {
      if (isCurrent()) this.isLoadingOlder.set(false);
    }
  }

  /** After Angular renders prepended items, keep the viewport on the same content. */
  private restoreScrollAfterPrepend(viewport: HTMLElement | null, scrollHeightBefore: number): void {
    runRestoreFrame(() => {
      if (viewport) {
        viewport.scrollTop += viewport.scrollHeight - scrollHeightBefore;
      }
    });
  }

  /**
   * Lightweight probe: check if stored transcript exists without loading messages.
   * Sets hasOlderMessages based on backend response.
   */
  private async probe(instanceId: string): Promise<void> {
    const isCurrent = (): boolean => this.deps.getInstanceId() === instanceId;
    try {
      const customProbe = this.deps.getOlderMessagesProbe();
      if (customProbe) {
        const data = await customProbe();
        if (data && isCurrent()) {
          this.hasOlderMessages.set(data.hasMore);
          this.hiddenMessageCount.set(Math.max(0, data.totalStored - this.deps.getMessages().length));
        }
        return;
      }
      const result = await this.deps.instanceIpc.loadOlderMessages(instanceId, { limit: 1 });
      if (result.success && result.data && isCurrent()) {
        const data = result.data as { messages: OutputMessage[]; hasMore: boolean; totalStored: number };
        this.hasOlderMessages.set(data.totalStored > 0);
        this.hiddenMessageCount.set(data.totalStored);
      }
    } catch {
      // Silently fail — button stays hidden
    }
  }
}
