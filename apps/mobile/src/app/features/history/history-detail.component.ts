import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import type { MobileMessageDto } from '../../core/models';

/** A transcript row: a single message, or a collapsed run of tool calls. */
type DisplayItem =
  | { kind: 'msg'; message: MobileMessageDto }
  | { kind: 'tools'; id: string; items: MobileMessageDto[] };

/**
 * Read-only transcript of a persisted (closed/archived) session, fetched from
 * the gateway's history store. No composer — closed sessions aren't resumable
 * from the phone; to continue work, start a new session in the project.
 */
@Component({
  standalone: true,
  selector: 'app-history-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="screen">
      <header class="top">
        <button class="back" (click)="back()">‹</button>
        <span class="info">
          <span class="name">Past session</span>
          <span class="sub">read-only</span>
        </span>
      </header>

      <div class="scroll-wrap">
        <div #scrollEl class="transcript" (scroll)="onScroll()">
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (error()) {
            <p class="error">{{ error() }}</p>
          } @else {
            @for (item of displayItems(); track trackItem(item)) {
              @if (item.kind === 'tools') {
                <div class="tool-group">
                  <button class="tool-toggle" (click)="toggleTools(item.id)">
                    <span class="tool-caret">{{ expandedTools().has(item.id) ? '▾' : '▸' }}</span>
                    🔧 {{ item.items.length }} tool {{ item.items.length === 1 ? 'call' : 'calls' }}
                  </button>
                  @if (expandedTools().has(item.id)) {
                    @for (t of item.items; track t.id) {
                      <div class="tool-line">{{ t.content }}</div>
                    }
                  }
                </div>
              } @else {
                <div class="msg" [class]="item.message.type">
                  @if (item.message.type !== 'user') {
                    <span class="role">{{ roleLabel(item.message.type) }}</span>
                  }
                  <span class="content">{{ item.message.content }}</span>
                </div>
              }
            }
            @if (messages().length === 0) {
              <p class="muted">This session has no recorded messages.</p>
            }
          }
        </div>

        @if (messages().length > 0) {
          <div class="scroll-btns">
            @if (!atTop()) {
              <button class="scroll-btn" (click)="scrollToTop()" aria-label="Scroll to top">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
              </button>
            }
            @if (!atBottom()) {
              <button class="scroll-btn" (click)="scrollToBottom()" aria-label="Scroll to bottom">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
            }
          </div>
        }
      </div>
    </section>
  `,
  styles: [
    `
      /* Full-viewport shell so the transcript scrolls internally, independent
         of the ancestor height chain (app-root only sets min-height). */
      :host {
        position: fixed; inset: 0; z-index: 0;
        display: flex; flex-direction: column; background: var(--bg);
        padding: env(safe-area-inset-top) env(safe-area-inset-right)
          env(safe-area-inset-bottom) env(safe-area-inset-left);
      }
      .screen { display: flex; flex-direction: column; flex: 1; min-height: 0; }
      .top { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); }
      .back { background: none; border: none; color: var(--accent-action); font-size: 26px; line-height: 1; }
      .info { display: flex; flex-direction: column; min-width: 0; }
      .name { font-size: 17px; font-weight: 600; }
      .sub { font-size: 13px; color: var(--text-secondary); }
      .scroll-wrap { flex: 1; position: relative; min-height: 0; display: flex; }
      .transcript { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
      .scroll-btns {
        position: absolute; right: 12px; bottom: 12px; z-index: 4;
        display: flex; flex-direction: column; gap: 8px;
      }
      .scroll-btn {
        width: 40px; height: 40px; border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(44, 44, 46, 0.92); color: var(--text);
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
      }
      .tool-group { display: flex; flex-direction: column; gap: 4px; }
      .tool-toggle {
        align-self: flex-start; display: flex; align-items: center; gap: 6px;
        background: none; border: none; color: var(--text-secondary);
        font-size: 13px; padding: 2px 0;
      }
      .tool-caret { font-size: 11px; width: 10px; }
      .tool-line {
        color: var(--text-secondary); font-size: 13px; padding-left: 16px;
        font-family: 'SF Mono', ui-monospace, monospace;
        white-space: pre-wrap; word-break: break-word;
      }
      .msg { display: flex; flex-direction: column; gap: 4px; max-width: 85%; }
      .msg.user { align-self: flex-end; align-items: flex-end; }
      .msg .role { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
      .msg .content {
        white-space: pre-wrap; word-break: break-word; font-size: 15px; line-height: 1.45;
        background: var(--surface); padding: 10px 12px; border-radius: 12px;
      }
      .msg.user .content { background: var(--accent-action); color: #fff; }
      .msg.error .content { background: rgba(255,69,58,0.15); color: var(--accent-error); }
      .muted { color: var(--text-secondary); text-align: center; margin-top: 40px; }
      .error { color: var(--accent-error); text-align: center; margin-top: 40px; }
    `,
  ],
})
export class HistoryDetailComponent implements OnInit {
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);

  /** Chat id from the route. */
  readonly chatId = input<string>('');

  protected readonly messages = signal<MobileMessageDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  /** Which collapsed tool groups the user has expanded (keyed by group id). */
  protected readonly expandedTools = signal<Set<string>>(new Set());

  /** Rows with consecutive tool calls folded into collapsible groups. */
  protected readonly displayItems = computed<DisplayItem[]>(() => {
    const out: DisplayItem[] = [];
    let bucket: MobileMessageDto[] | null = null;
    for (const m of this.messages()) {
      if (m.type === 'tool_use' || m.type === 'tool_result') {
        if (!bucket) {
          bucket = [];
          out.push({ kind: 'tools', id: `tools-${m.id}`, items: bucket });
        }
        bucket.push(m);
      } else {
        bucket = null;
        out.push({ kind: 'msg', message: m });
      }
    }
    return out;
  });

  protected trackItem(item: DisplayItem): string {
    return item.kind === 'tools' ? item.id : item.message.id;
  }

  protected toggleTools(id: string): void {
    this.expandedTools.update((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Scroll-position flags driving the floating up/down buttons. */
  protected readonly atTop = signal(true);
  protected readonly atBottom = signal(true);
  /** Jump to the newest message only on the first render after messages load. */
  private didInitialScroll = false;

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scrollEl');

  constructor() {
    // Once messages have loaded and the transcript element exists, jump to the
    // bottom (newest message) and surface the scroll buttons. Tracks scrollEl()
    // too so it re-runs when the viewChild resolves after the initial render.
    effect(() => {
      const hasMessages = this.messages().length > 0;
      const el = this.scrollEl()?.nativeElement;
      if (!el || !hasMessages || this.didInitialScroll) return;
      this.didInitialScroll = true;
      queueMicrotask(() => {
        el.scrollTop = el.scrollHeight;
        this.updateScrollFlags();
      });
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      const messages = await this.gateway.historyMessages(this.chatId());
      this.messages.set(messages);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** Recompute top/bottom flags from the current scroll position. */
  private updateScrollFlags(): void {
    const el = this.scrollEl()?.nativeElement;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.atBottom.set(distanceFromBottom < 80);
    this.atTop.set(el.scrollTop < 40);
  }

  protected onScroll(): void {
    this.updateScrollFlags();
  }

  protected scrollToTop(): void {
    this.scrollEl()?.nativeElement.scrollTo({ top: 0, behavior: 'smooth' });
  }

  protected scrollToBottom(): void {
    const el = this.scrollEl()?.nativeElement;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }

  protected roleLabel(type: MobileMessageDto['type']): string {
    switch (type) {
      case 'assistant':
        return 'assistant';
      case 'tool_use':
        return 'tool';
      case 'tool_result':
        return 'tool';
      case 'error':
        return 'error';
      default:
        return 'system';
    }
  }

  protected back(): void {
    void this.router.navigate(['/history']);
  }
}
