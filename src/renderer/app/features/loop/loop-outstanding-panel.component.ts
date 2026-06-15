import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import type { LoopOutstandingItemPayload } from '@contracts/schemas/loop';
import { LoopStore } from '../../core/state/loop.store';
import { loopStatusLabel, relativeTime, formatTimestamp } from './loop-formatters.util';

/**
 * Aggregated "Outstanding" panel — surfaces the human-gated work captured from
 * completed loop runs (OUTSTANDING.md's "Needs human" + "Open questions") so it
 * doesn't get lost in the chat scroll-back or the hidden per-run state dir.
 *
 * Scoped to the session that produced the loop items, with workspace retained
 * for export. Items can be marked resolved / dismissed (which persists to the
 * DB), and the open set can be exported to a consolidated `OUTSTANDING.md` on
 * demand.
 */
@Component({
  selector: 'app-loop-outstanding-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="outstanding">
      <div class="o-head">
        <span class="o-title">Outstanding</span>
        <span class="o-count" [class.has-open]="openCount() > 0">{{ openCount() }} open</span>
        <span class="o-spacer"></span>
        <button
          type="button"
          class="o-filter"
          (click)="toggleShowAll()"
          [attr.aria-pressed]="showAll()"
          [title]="showAll() ? 'Show only open items' : 'Show resolved/dismissed too'"
        >{{ showAll() ? 'All' : 'Open only' }}</button>
        <button
          type="button"
          class="o-resolve-all"
          (click)="onResolveAll()"
          [disabled]="openCount() === 0 || resolvingAll()"
          title="Mark every open item resolved"
        >{{ resolvingAll() ? 'Resolving…' : 'Resolve all' }}</button>
        <button
          type="button"
          class="o-export"
          (click)="onExport()"
          [disabled]="!workspaceCwd() || exporting() || openCount() === 0"
          [title]="exportTitle()"
        >{{ exportedPath() ? 'Exported ✓' : 'Export .md' }}</button>
      </div>

      @if (store.outstandingIsLoading() && items().length === 0) {
        <div class="o-empty">Loading…</div>
      } @else if (items().length === 0) {
        <div class="o-empty">No outstanding items. 🎉</div>
      } @else {
        @if (needsHuman().length > 0) {
          <div class="o-section-label">Needs human</div>
          <div class="o-list" role="list">
            @for (item of needsHuman(); track item.id) {
              <div class="o-row" role="listitem" [attr.data-status]="item.status">
                <div class="o-row-main">
                  <div class="o-text">{{ item.text }}</div>
                  <div class="o-meta">
                    <span class="o-loop-status" [attr.data-status]="item.loopStatus">{{ statusLabel(item.loopStatus) }}</span>
                    <span class="o-time" [title]="absoluteTime(item.createdAt)">{{ relTime(item.createdAt) }}</span>
                    @if (item.status !== 'open') {
                      <span class="o-resolved">{{ item.status }}</span>
                    }
                  </div>
                </div>
                <div class="o-actions">
                  @if (item.status === 'open') {
                    <button type="button" class="o-act o-resolve" (click)="setStatus(item, 'resolved')" title="Mark resolved">Resolve</button>
                    <button type="button" class="o-act o-dismiss" (click)="setStatus(item, 'dismissed')" title="Dismiss — not going to do this">Dismiss</button>
                  } @else {
                    <button type="button" class="o-act" (click)="setStatus(item, 'open')" title="Re-open">Reopen</button>
                  }
                </div>
              </div>
            }
          </div>
        }
        @if (openQuestions().length > 0) {
          <div class="o-section-label">Open questions</div>
          <div class="o-list" role="list">
            @for (item of openQuestions(); track item.id) {
              <div class="o-row" role="listitem" [attr.data-status]="item.status">
                <div class="o-row-main">
                  <div class="o-text">{{ item.text }}</div>
                  <div class="o-meta">
                    <span class="o-loop-status" [attr.data-status]="item.loopStatus">{{ statusLabel(item.loopStatus) }}</span>
                    <span class="o-time" [title]="absoluteTime(item.createdAt)">{{ relTime(item.createdAt) }}</span>
                    @if (item.status !== 'open') {
                      <span class="o-resolved">{{ item.status }}</span>
                    }
                  </div>
                </div>
                <div class="o-actions">
                  @if (item.status === 'open') {
                    <button type="button" class="o-act o-resolve" (click)="setStatus(item, 'resolved')" title="Mark answered">Answered</button>
                    <button type="button" class="o-act o-dismiss" (click)="setStatus(item, 'dismissed')" title="Dismiss">Dismiss</button>
                  } @else {
                    <button type="button" class="o-act" (click)="setStatus(item, 'open')" title="Re-open">Reopen</button>
                  }
                </div>
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .outstanding {
      margin: 6px 0;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      background: rgba(255,255,255,0.025);
      font-size: 12px;
      padding: 8px 10px;
    }
    .o-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .o-title { font-weight: 600; }
    .o-count {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 1px 6px; border-radius: 3px;
      background: rgba(255,255,255,0.08); opacity: 0.7;
    }
    .o-count.has-open { color: #f7c07a; background: rgba(247,192,122,0.14); opacity: 1; }
    .o-spacer { flex: 1; }
    .o-filter, .o-export {
      padding: 2px 8px; font: inherit; font-size: 11px;
      background: rgba(255,255,255,0.05); color: inherit;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 3px;
      cursor: pointer;
    }
    .o-export { border-color: rgba(212,180,90,0.5); color: var(--primary-color, #d4b45a); }
    .o-export:hover:not(:disabled) { background: rgba(212,180,90,0.12); }
    .o-resolve-all { border-color: rgba(142,220,142,0.4); color: #8edc8e; }
    .o-resolve-all:hover:not(:disabled) { background: rgba(142,220,142,0.12); }
    .o-filter:disabled, .o-export:disabled, .o-resolve-all:disabled { opacity: 0.4; cursor: not-allowed; }
    .o-empty { padding: 10px 4px; opacity: 0.6; font-style: italic; }
    .o-section-label {
      margin: 8px 0 4px; font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.04em; opacity: 0.55;
    }
    .o-list { display: flex; flex-direction: column; gap: 6px; }
    .o-row {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 6px 8px;
      border: 1px solid rgba(255,255,255,0.06); border-radius: 4px;
      background: rgba(0,0,0,0.18);
    }
    .o-row[data-status="resolved"], .o-row[data-status="dismissed"] { opacity: 0.5; }
    .o-row-main { flex: 1; min-width: 0; }
    .o-text { line-height: 1.45; word-break: break-word; white-space: pre-wrap; }
    .o-meta { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
    .o-loop-status {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,0.08); opacity: 0.7;
    }
    .o-loop-status[data-status="completed-needs-review"] { color: #f7c07a; background: rgba(247,192,122,0.12); }
    .o-loop-status[data-status="completed"] { color: #8edc8e; background: rgba(142,220,142,0.12); }
    .o-time { opacity: 0.55; font-family: var(--font-mono, monospace); font-size: 10px; }
    .o-resolved {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 1px 5px; border-radius: 3px; color: #8edc8e; background: rgba(142,220,142,0.1);
    }
    .o-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .o-act {
      padding: 2px 8px; font: inherit; font-size: 11px;
      background: rgba(255,255,255,0.05); color: inherit;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; cursor: pointer;
    }
    .o-act:hover { background: rgba(255,255,255,0.1); }
    .o-resolve { border-color: rgba(142,220,142,0.4); color: #8edc8e; }
    .o-dismiss { opacity: 0.75; }
  `],
})
export class LoopOutstandingPanelComponent {
  /** Session/chat to show outstanding items for. Null falls back to workspace scope. */
  chatId = input<string | null>(null);
  /** Workspace to export outstanding items for. Null disables export. */
  workspaceCwd = input<string | null>(null);
  /** Test seam for relative-time rendering; production leaves at 0. */
  nowOverride = input<number>(0);

  protected store = inject(LoopStore);

  protected showAll = signal(false);
  protected resolvingAll = signal(false);
  protected exporting = signal(false);
  protected exportedPath = signal<string | null>(null);
  private exportClearHandle: ReturnType<typeof setTimeout> | null = null;

  /** Items scoped to this session/workspace (the store holds the latest query result). */
  protected items = computed<LoopOutstandingItemPayload[]>(() => {
    const chatId = this.chatId();
    const cwd = this.workspaceCwd();
    if (!chatId && !cwd) return [];
    return this.store.outstanding().filter((i) => (
      chatId ? i.chatId === chatId : i.workspaceCwd === cwd
    ));
  });

  protected needsHuman = computed(() => this.items().filter((i) => i.kind === 'needs-human'));
  protected openQuestions = computed(() => this.items().filter((i) => i.kind === 'open-question'));
  protected openCount = computed(() => this.items().filter((i) => i.status === 'open').length);

  constructor() {
    this.store.ensureWired();
    // (Re)load whenever the session/workspace or filter changes.
    effect(() => {
      const chatId = this.chatId();
      const cwd = this.workspaceCwd();
      const status = this.showAll() ? ('all' as const) : ('open' as const);
      if (!chatId && !cwd) return;
      untracked(() => {
        if (chatId) {
          void this.store.loadOutstanding({ chatId, status });
        } else if (cwd) {
          void this.store.loadOutstanding({ workspaceCwd: cwd, status });
        }
      });
    });
  }

  protected toggleShowAll(): void {
    this.showAll.update((v) => !v);
  }

  protected async setStatus(
    item: LoopOutstandingItemPayload,
    status: 'open' | 'resolved' | 'dismissed',
  ): Promise<void> {
    await this.store.setOutstandingStatus(item.id, status);
  }

  /** Resolve every currently-open item for this workspace in one batch. */
  protected async onResolveAll(): Promise<void> {
    if (this.resolvingAll()) return;
    const openIds = this.items().filter((i) => i.status === 'open').map((i) => i.id);
    if (openIds.length === 0) return;
    this.resolvingAll.set(true);
    try {
      await this.store.setOutstandingStatusBulk(openIds, 'resolved');
    } finally {
      this.resolvingAll.set(false);
    }
  }

  protected exportTitle(): string {
    if (!this.workspaceCwd()) return 'No workspace selected';
    if (this.openCount() === 0) return 'No open items to export';
    return 'Write open items to <workspace>/OUTSTANDING.md';
  }

  protected async onExport(): Promise<void> {
    const cwd = this.workspaceCwd();
    if (!cwd) return;
    this.exporting.set(true);
    try {
      const result = await this.store.exportOutstanding(cwd, undefined, this.chatId() ?? undefined);
      if (result) {
        this.exportedPath.set(result.path);
        if (this.exportClearHandle) clearTimeout(this.exportClearHandle);
        this.exportClearHandle = setTimeout(() => this.exportedPath.set(null), 2500);
      }
    } finally {
      this.exporting.set(false);
    }
  }

  protected statusLabel(status: string): string {
    return loopStatusLabel(status);
  }

  protected relTime(ts: number): string {
    const override = this.nowOverride();
    return relativeTime(ts, override > 0 ? override : Date.now());
  }

  protected absoluteTime(ts: number): string {
    return formatTimestamp(ts);
  }
}
