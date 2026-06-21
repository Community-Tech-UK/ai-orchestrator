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
 * The non-empty answer the user has typed this session but not yet saved — an
 * explicit draft edit that differs from the persisted value. Returns the text to
 * persist, or undefined when there's no pending answer edit.
 *
 * A pre-filled recommendation (draft === undefined) is NOT an unsaved answer: it
 * only becomes one once the user edits or saves it. An edit that just clears the
 * box (whitespace-only) is also not an answer.
 *
 * Pure + exported so it can be unit-tested without an Angular TestBed (the
 * project's vitest config has no Angular compiler plugin).
 */
export function outstandingUnsavedAnswer(
  userResponse: string | null | undefined,
  draft: string | undefined,
): string | undefined {
  if (draft === undefined) return undefined;
  if (draft === (userResponse ?? '')) return undefined;
  return draft.trim().length > 0 ? draft : undefined;
}

/**
 * Whether an outstanding item has an answer to resume with: either a persisted
 * `userResponse`, or one typed this session (flushed to the DB on resume). This
 * is what "Resume with answers (N)" counts.
 */
export function outstandingHasAnswer(
  userResponse: string | null | undefined,
  draft: string | undefined,
): boolean {
  return (userResponse ?? '').trim().length > 0
    || outstandingUnsavedAnswer(userResponse, draft) !== undefined;
}

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
        <button
          type="button"
          class="o-resume"
          (click)="onResume()"
          [disabled]="!canResume() || resuming()"
          [title]="resumeTitle()"
        >{{ resuming() ? 'Starting…' : 'Resume with answers (' + answeredCount() + ')' }}</button>
      </div>
      @if (resumeError()) {
        <div class="o-resume-error">{{ resumeError() }}</div>
      }

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
                  @if (item.status === 'open') {
                    @if (isShowingRecommendation(item)) {
                      <div class="o-suggested" title="The loop drafted this; edit if needed, then Save or Resolve to record it">✨ Suggested — review, then Save or Resolve to use</div>
                    }
                    <textarea
                      class="o-answer-input"
                      rows="2"
                      placeholder="Your decision / answer — saved with the item and fed back when you resume the loop"
                      [value]="draftFor(item)"
                      (input)="onDraftInput(item, $event)"
                    ></textarea>
                  } @else if (item.userResponse) {
                    <div class="o-answer"><span class="o-answer-label">Answer</span>{{ item.userResponse }}</div>
                  }
                </div>
                <div class="o-actions">
                  @if (item.status === 'open') {
                    <button type="button" class="o-act o-save" (click)="saveAnswer(item)" [disabled]="savingId() === item.id || !canSaveAnswer(item)" title="Save your answer (item stays open)">{{ savingId() === item.id ? 'Saving…' : 'Save answer' }}</button>
                    <button type="button" class="o-act o-resolve" (click)="setStatus(item, 'resolved')" title="Save answer (if any) and mark resolved">Resolve</button>
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
                  @if (item.status === 'open') {
                    @if (isShowingRecommendation(item)) {
                      <div class="o-suggested" title="The loop drafted this; edit if needed, then Save or Resolve to record it">✨ Suggested — review, then Save or Resolve to use</div>
                    }
                    <textarea
                      class="o-answer-input"
                      rows="2"
                      placeholder="Your answer — saved with the item and fed back when you resume the loop"
                      [value]="draftFor(item)"
                      (input)="onDraftInput(item, $event)"
                    ></textarea>
                  } @else if (item.userResponse) {
                    <div class="o-answer"><span class="o-answer-label">Answer</span>{{ item.userResponse }}</div>
                  }
                </div>
                <div class="o-actions">
                  @if (item.status === 'open') {
                    <button type="button" class="o-act o-save" (click)="saveAnswer(item)" [disabled]="savingId() === item.id || !canSaveAnswer(item)" title="Save your answer (item stays open)">{{ savingId() === item.id ? 'Saving…' : 'Save answer' }}</button>
                    <button type="button" class="o-act o-resolve" (click)="setStatus(item, 'resolved')" title="Save answer (if any) and mark answered">Answered</button>
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
    .o-resume {
      padding: 2px 8px; font: inherit; font-size: 11px;
      background: rgba(123,176,255,0.1); color: #9ec1ff;
      border: 1px solid rgba(123,176,255,0.5); border-radius: 3px; cursor: pointer;
    }
    .o-resume:hover:not(:disabled) { background: rgba(123,176,255,0.2); }
    .o-resume-error { margin: 2px 0 6px; color: #f08a8a; font-size: 11px; }
    .o-filter:disabled, .o-export:disabled, .o-resolve-all:disabled, .o-resume:disabled { opacity: 0.4; cursor: not-allowed; }
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
    .o-suggested {
      margin-top: 6px; font-size: 10px; letter-spacing: 0.02em;
      color: #9ec1ff; opacity: 0.9;
    }
    .o-suggested + .o-answer-input { margin-top: 3px; }
    .o-answer-input {
      display: block; width: 100%; box-sizing: border-box; margin-top: 6px;
      padding: 5px 7px; font: inherit; font-size: 11px; line-height: 1.4;
      color: inherit; background: rgba(0,0,0,0.25);
      border: 1px solid rgba(255,255,255,0.14); border-radius: 4px;
      resize: vertical; min-height: 34px;
    }
    .o-answer-input:focus {
      outline: none; border-color: rgba(212,180,90,0.6);
      background: rgba(0,0,0,0.35);
    }
    .o-answer {
      margin-top: 6px; padding: 5px 7px; line-height: 1.45;
      white-space: pre-wrap; word-break: break-word;
      background: rgba(142,220,142,0.06); border-left: 2px solid rgba(142,220,142,0.5);
      border-radius: 0 4px 4px 0;
    }
    .o-answer-label {
      display: inline-block; margin-right: 6px; font-size: 9px;
      text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.55;
    }
    .o-actions { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
    .o-act {
      padding: 2px 8px; font: inherit; font-size: 11px; white-space: nowrap;
      background: rgba(255,255,255,0.05); color: inherit;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; cursor: pointer;
    }
    .o-act:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
    .o-act:disabled { opacity: 0.4; cursor: not-allowed; }
    .o-save { border-color: rgba(212,180,90,0.5); color: var(--primary-color, #d4b45a); }
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

  /** Per-item unsaved answer edits, keyed by item id. An entry exists only while
   *  the textarea differs from what's been typed this session; cleared after a
   *  successful save so the field falls back to the persisted `userResponse`. */
  protected drafts = signal<Record<string, string>>({});
  /** Id of the item whose answer is currently being persisted (button spinner). */
  protected savingId = signal<string | null>(null);

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
  /** Open items that carry an answer — what "Resume with answers" feeds back.
   *  Counts both a persisted `userResponse` AND a non-empty answer the user has
   *  typed but not yet clicked "Save answer" on: those unsaved drafts are flushed
   *  to the DB on resume (see `onResume`), so the count must reflect them or a
   *  typed answer would silently show "Resume with answers (0)". */
  protected answeredCount = computed(
    () => this.items().filter((i) => i.status === 'open' && this.hasAnswer(i)).length,
  );
  protected resuming = signal(false);
  protected resumeError = signal<string | null>(null);

  /** Resume needs a session scope (chatId) and at least one answered item. */
  protected canResume = computed(() => !!this.chatId() && !!this.workspaceCwd() && this.answeredCount() > 0);

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

  /** The text to show in the answer textarea, in priority order: the unsaved
   *  draft (if edited this session), else the persisted human answer, else the
   *  agent's recommendation as an editable suggestion, else empty. */
  protected draftFor(item: LoopOutstandingItemPayload): string {
    const draft = this.drafts()[item.id];
    if (draft !== undefined) return draft;
    const saved = item.userResponse ?? '';
    if (saved) return saved;
    return item.recommendedAnswer ?? '';
  }

  /** True when the textarea is showing the agent's recommendation as a pre-fill
   *  (no unsaved edit and no saved answer yet) — drives the "Suggested" badge.
   *  A recommendation is a suggestion only; it does not count as an answer until
   *  the human saves it, so `answeredCount`/Resume stay gated on `userResponse`. */
  protected isShowingRecommendation(item: LoopOutstandingItemPayload): boolean {
    return this.drafts()[item.id] === undefined
      && !(item.userResponse ?? '').trim()
      && !!(item.recommendedAnswer ?? '').trim();
  }

  /** Whether "Save answer" should be enabled: an explicit edit that differs from
   *  the persisted answer, or a pre-filled recommendation the user hasn't saved. */
  protected canSaveAnswer(item: LoopOutstandingItemPayload): boolean {
    const draft = this.drafts()[item.id];
    if (draft !== undefined) return draft !== (item.userResponse ?? '');
    return this.isShowingRecommendation(item);
  }

  /** A non-empty answer the user has typed this session but not yet saved (an
   *  explicit edit that differs from the persisted value). Returns the text to
   *  persist, or undefined when there's no pending edit. A pre-filled
   *  recommendation is NOT an unsaved answer — it only becomes one once the user
   *  edits or saves it (matching `isShowingRecommendation`). */
  private unsavedAnswer(item: LoopOutstandingItemPayload): string | undefined {
    return outstandingUnsavedAnswer(item.userResponse, this.drafts()[item.id]);
  }

  /** True when the item has an answer to resume with: either persisted, or typed
   *  this session (and flushed on resume). */
  protected hasAnswer(item: LoopOutstandingItemPayload): boolean {
    return outstandingHasAnswer(item.userResponse, this.drafts()[item.id]);
  }

  protected onDraftInput(item: LoopOutstandingItemPayload, event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.drafts.update((m) => ({ ...m, [item.id]: value }));
  }

  /** Persist the typed answer without changing status (item stays open). */
  protected async saveAnswer(item: LoopOutstandingItemPayload): Promise<void> {
    await this.commit(item, item.status, this.draftFor(item));
  }

  protected async setStatus(
    item: LoopOutstandingItemPayload,
    status: 'open' | 'resolved' | 'dismissed',
  ): Promise<void> {
    // Resolve accepts whatever the box shows — a typed answer OR the pre-filled
    // recommendation — so a one-click Resolve records the decision (this is the
    // human accepting the suggestion). Dismiss/reopen only carry an explicit edit:
    // dismissing means "not doing this", so the suggestion is never baked in as an
    // answer, and reopening must not silently adopt the recommendation.
    const response = status === 'resolved' ? this.draftFor(item) : this.drafts()[item.id];
    await this.commit(item, status, response);
  }

  /** Single write path: set status (+ optional answer) then drop the local draft
   *  so the textarea reflects the persisted value. */
  private async commit(
    item: LoopOutstandingItemPayload,
    status: 'open' | 'resolved' | 'dismissed',
    response: string | undefined,
  ): Promise<void> {
    if (this.savingId() === item.id) return;
    this.savingId.set(item.id);
    try {
      const ok = await this.store.setOutstandingStatus(item.id, status, response);
      if (ok) {
        this.drafts.update((m) => {
          const next = { ...m };
          delete next[item.id];
          return next;
        });
      }
    } finally {
      this.savingId.set(null);
    }
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

  protected resumeTitle(): string {
    if (!this.chatId()) return 'Resume needs a session — open this from an instance';
    if (this.answeredCount() === 0) return 'Type an answer on an item first';
    return 'Start a new loop run that applies your answers';
  }

  /** Start a fresh loop run that applies the saved answers; the consumed items
   *  are resolved server-side and the panel refreshes via the change event.
   *  Any answers typed but not explicitly saved are flushed first so the server
   *  (which reads the persisted answers) feeds them back. */
  protected async onResume(): Promise<void> {
    const chatId = this.chatId();
    const cwd = this.workspaceCwd();
    if (!chatId || !cwd || this.resuming()) return;
    this.resumeError.set(null);
    this.resuming.set(true);
    try {
      await this.flushUnsavedAnswers();
      const result = await this.store.resumeOutstandingWithAnswers(chatId, cwd);
      if (!result.ok) this.resumeError.set(result.error);
    } finally {
      this.resuming.set(false);
    }
  }

  /** Persist every open item's typed-but-unsaved answer (status stays open) so a
   *  subsequent resume sees them. Mirrors what "Save answer" does, in a batch. */
  private async flushUnsavedAnswers(): Promise<void> {
    const pending = this.items()
      .filter((i) => i.status === 'open')
      .map((i) => ({ id: i.id, answer: this.unsavedAnswer(i) }))
      .filter((p): p is { id: string; answer: string } => p.answer !== undefined);
    for (const { id, answer } of pending) {
      const ok = await this.store.setOutstandingStatus(id, 'open', answer);
      if (ok) {
        this.drafts.update((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
      }
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
