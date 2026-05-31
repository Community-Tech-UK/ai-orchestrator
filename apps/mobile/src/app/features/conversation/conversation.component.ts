import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import { statusColor, statusLabel } from '../../core/status';
import type { MobileMessageDto } from '../../core/models';

/**
 * A rendered transcript row: either a single conversational message, or a
 * collapsed run of consecutive tool calls (the "🔧 Using tool: …" noise),
 * shown as one tappable "N tool calls" group that expands on demand.
 */
type DisplayItem =
  | { kind: 'msg'; message: MobileMessageDto }
  | { kind: 'tools'; id: string; items: MobileMessageDto[] };

/**
 * One agent's live conversation: transcript (replayed history + live stream),
 * a status/context header, an input bar, and Stop/terminate controls. Approval
 * prompts surface through the global approval sheet (app.component).
 */
@Component({
  standalone: true,
  selector: 'app-conversation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="screen">
      <header class="top">
        <button class="back" (click)="back()">‹</button>
        <div class="title">
          <span class="dot" [style.background]="color(status())"></span>
          <span class="name">{{ instance()?.displayName ?? 'Session' }}</span>
        </div>
        <button class="menu" (click)="menuOpen.set(!menuOpen())" aria-label="More">⋯</button>
      </header>

      <div class="subheader">
        <span>{{ label(status()) }}</span>
        @if (instance()?.contextPercentage !== undefined) {
          <span class="ctx">· context {{ instance()?.contextPercentage }}%</span>
        }
        @if (!online()) {
          <span class="offline">· offline</span>
        }
      </div>

      @if (menuOpen()) {
        <div class="popover">
          <button (click)="rename()">Rename</button>
          <button (click)="interrupt()" [disabled]="!online()">Stop (interrupt)</button>
          <button class="danger" (click)="terminate()" [disabled]="!online()">Terminate</button>
        </div>
      }

      <div class="scroll-wrap">
        <div #scrollEl class="transcript" (scroll)="onScroll()">
          @for (item of displayItems(); track trackItem(item)) {
            @if (item.kind === 'tools') {
              <div class="tool-group">
                <button class="tool-toggle" (click)="toggleTools(item.id)">
                  <span class="tool-caret">{{ expandedTools().has(item.id) ? '▾' : '▸' }}</span>
                  🔧 {{ item.items.length }} tool {{ item.items.length === 1 ? 'call' : 'calls' }}
                </button>
                @if (expandedTools().has(item.id)) {
                  @for (t of item.items; track t.id) {
                    <div class="tool-line">{{ toolLabel(t) }}</div>
                  }
                }
              </div>
            } @else {
              <div class="msg" [class]="'t-' + item.message.type">
                <span class="bubble">{{ item.message.content }}</span>
              </div>
            }
          } @empty {
            <p class="muted center">{{ online() ? 'No messages yet.' : 'Connecting…' }}</p>
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

      <form class="composer" (submit)="send($event)">
        <textarea
          rows="1"
          [ngModel]="draft()"
          (ngModelChange)="draft.set($event)"
          [ngModelOptions]="{ standalone: true }"
          placeholder="Message…"
          (keydown.enter)="onEnter($event)"
        ></textarea>
        <button type="submit" class="send" [disabled]="!online() || !draft().trim() || sending()">
          {{ sending() ? '…' : '↑' }}
        </button>
      </form>
    </section>
  `,
  styles: [
    `
      /* Full-viewport shell so the transcript is a real internal scroll
         container, independent of the ancestor height chain (app-root only
         sets min-height, which would otherwise collapse height:100% here). */
      :host {
        position: fixed; inset: 0; z-index: 0;
        display: flex; flex-direction: column; background: var(--bg);
        padding: env(safe-area-inset-top) env(safe-area-inset-right)
          env(safe-area-inset-bottom) env(safe-area-inset-left);
      }
      .screen { display: flex; flex-direction: column; flex: 1; min-height: 0; }
      .top { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
      .back { background: none; border: none; color: var(--accent-action); font-size: 26px; line-height: 1; }
      .title { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
      .title .name { font-size: 17px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
      .menu { background: none; border: none; color: var(--text); font-size: 22px; }
      .subheader { padding: 0 16px 8px; color: var(--text-secondary); font-size: 13px; text-transform: capitalize; }
      .subheader .offline { color: var(--accent-attention); }
      .popover {
        position: absolute; right: 12px; top: 52px; z-index: 5;
        background: var(--surface-2); border-radius: 12px; padding: 6px;
        display: flex; flex-direction: column; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      }
      .popover button { background: none; border: none; color: var(--text); text-align: left; padding: 10px 16px; font-size: 15px; }
      .popover button.danger { color: var(--accent-error); }
      .scroll-wrap { flex: 1; position: relative; min-height: 0; display: flex; }
      .transcript { flex: 1; overflow-y: auto; padding: 8px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
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
      /* Collapsed tool-activity group — hides the "Using tool: …" junk. */
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
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .msg { display: flex; }
      .bubble { white-space: pre-wrap; word-break: break-word; font-size: 15px; line-height: 1.4; }
      .t-user { justify-content: flex-end; }
      .t-user .bubble { background: var(--accent-action); color: #fff; padding: 8px 12px; border-radius: 16px; max-width: 80%; }
      .t-assistant .bubble { color: var(--text); }
      .t-system { justify-content: center; }
      .t-system .bubble { color: var(--text-secondary); font-size: 13px; text-align: center; }
      .t-error .bubble { color: var(--accent-error); }
      .t-tool_use .tool, .t-tool_result .bubble { color: var(--text-secondary); font-size: 13px; font-family: 'SF Mono', ui-monospace, monospace; }
      .muted { color: var(--text-secondary); }
      .center { text-align: center; margin-top: 40px; }
      .composer { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid rgba(255,255,255,0.08); align-items: flex-end; }
      .composer textarea {
        flex: 1; resize: none; max-height: 120px; background: var(--surface); color: var(--text);
        border: 1px solid rgba(255,255,255,0.12); border-radius: 18px; padding: 10px 14px; font-size: 16px; font-family: inherit;
      }
      .send {
        width: 40px; height: 40px; border-radius: 50%; border: none; flex: none;
        background: var(--accent-action); color: #fff; font-size: 20px;
      }
      .send:disabled { opacity: 0.4; }
    `,
  ],
})
export class ConversationComponent {
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);

  readonly projectKey = input<string>('');
  readonly instanceId = input<string>('');

  protected readonly draft = signal('');
  protected readonly sending = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly online = this.gateway.online;
  protected readonly color = statusColor;
  protected readonly label = statusLabel;

  /** Scroll-position flags driving the floating up/down buttons + auto-follow. */
  protected readonly atTop = signal(true);
  protected readonly atBottom = signal(true);
  /** Don't auto-follow new messages while the user is reading scrolled-up history. */
  private stickToBottom = true;

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scrollEl');

  protected readonly instance = computed(() =>
    this.gateway.snapshot()?.instances.find((i) => i.id === this.instanceId()),
  );
  protected readonly status = computed(() => this.instance()?.status ?? 'idle');
  protected readonly messages = computed(() => this.gateway.messagesFor(this.instanceId()));

  /** Which collapsed tool groups the user has expanded (keyed by group id). */
  protected readonly expandedTools = signal<Set<string>>(new Set());

  /**
   * Transcript rows with consecutive tool_use/tool_result messages folded into
   * a single collapsible group, so the conversation isn't drowned in tool noise.
   */
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

  constructor() {
    // Load (and resync on reconnect) the transcript for the open instance.
    effect(() => {
      const id = this.instanceId();
      if (id && this.gateway.online()) {
        void this.gateway.loadMessages(id);
      }
    });
    // Auto-scroll to the newest message — but only while the user is parked at
    // the bottom. If they've scrolled up to read history, leave them there.
    effect(() => {
      void this.messages().length;
      // Track the viewChild too: on a one-shot history load the effect can fire
      // before the transcript element exists; re-run once it resolves so we still
      // scroll to the bottom and surface the floating buttons.
      const el = this.scrollEl()?.nativeElement;
      if (!el) return;
      queueMicrotask(() => {
        if (this.stickToBottom) {
          el.scrollTop = el.scrollHeight;
        }
        this.updateScrollFlags();
      });
    });
  }

  /** Recompute top/bottom flags + whether to keep following new messages. */
  private updateScrollFlags(): void {
    const el = this.scrollEl()?.nativeElement;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = distanceFromBottom < 80;
    this.atBottom.set(bottom);
    this.atTop.set(el.scrollTop < 40);
    this.stickToBottom = bottom;
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
      this.stickToBottom = true;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }

  protected toolLabel(m: MobileMessageDto): string {
    const tool = (m.metadata?.['toolName'] as string) || (m.metadata?.['tool_name'] as string);
    return tool || m.content || 'tool';
  }

  protected onEnter(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (!keyboard.shiftKey) {
      event.preventDefault();
      void this.send(event);
    }
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    const text = this.draft().trim();
    if (!text || this.sending() || !this.online()) return;
    this.sending.set(true);
    this.draft.set('');
    try {
      await this.gateway.sendInput(this.instanceId(), text);
    } catch {
      this.draft.set(text); // restore on failure
    } finally {
      this.sending.set(false);
    }
  }

  protected async interrupt(): Promise<void> {
    this.menuOpen.set(false);
    try {
      await this.gateway.interrupt(this.instanceId());
    } catch {
      /* surfaced via status */
    }
  }

  protected async terminate(): Promise<void> {
    this.menuOpen.set(false);
    if (!confirm('Terminate this session?')) return;
    try {
      await this.gateway.terminate(this.instanceId());
      this.back();
    } catch {
      /* ignore */
    }
  }

  protected async rename(): Promise<void> {
    this.menuOpen.set(false);
    const name = prompt('Rename session', this.instance()?.displayName ?? '');
    if (name && name.trim()) {
      try {
        await this.gateway.rename(this.instanceId(), name.trim());
      } catch {
        /* ignore */
      }
    }
  }

  protected back(): void {
    void this.router.navigate(['/projects', this.projectKey(), 'sessions']);
  }
}
