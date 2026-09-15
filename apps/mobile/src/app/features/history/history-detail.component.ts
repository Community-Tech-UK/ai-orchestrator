import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  DestroyRef,
  untracked,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import { MobileBrowseStateStore } from '../../core/mobile-browse-state.store';
import { newSessionPresetState } from '../new-session/new-session.navigation';
import type { MobileHistorySessionDto, MobileMessageDto } from '../../core/models';
import { CodeCopyDirective } from '../../shared/code-copy.directive';
import { CopyButtonComponent } from '../../shared/copy-button.component';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { renderMobileMarkdown } from '../../shared/mobile-markdown';
import {
  buildDisplayItems,
  isLoopTranscriptMessage,
  toolLabel,
  toolDetails,
  type DisplayItem,
} from '../../shared/transcript-items';

/**
 * Read-only transcript of a persisted (closed/archived) session, fetched from
 * the gateway's history store. No composer — closed sessions aren't resumable
 * from the phone; to continue work, start a new session in the project.
 */
@Component({
  standalone: true,
  selector: 'app-history-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CopyButtonComponent,
    CodeCopyDirective,
    MobileHeaderComponent,
    MobileIconComponent,
  ],
  template: `
    <section class="screen">
      <app-mobile-header class="history-header" [title]="session()?.name || 'Past session'" [subtitle]="online() ? 'Read-only' : 'Read-only · Offline'">
        <button
          mobileHeaderLeading
          class="mobile-icon-button"
          type="button"
          (click)="back()"
          [attr.aria-label]="returnRoute() === '/projects' ? 'Back to projects' : 'Back to history'"
        >
          <app-mobile-icon name="chevron-left" />
        </button>
        <span mobileHeaderTrailing aria-hidden="true"></span>
      </app-mobile-header>

      @if (identityLoading()) {
        <p class="identity-feedback" role="status">Loading session details…</p>
      }
      @if (identityError()) {
        <div class="identity-feedback" role="alert">{{ identityError() }}
          <button type="button" (click)="loadIdentity()" [disabled]="identityLoading()">Retry session details</button>
        </div>
      }
      <details class="session-identity">
        <summary>Session details</summary>
        <p>{{ session()?.name || 'Past session' }}</p>
        @if (session(); as info) {
          <p>{{ info.projectName }} · {{ info.archived ? 'Archived' : 'Past session' }}</p>
          <p>{{ info.workingDirectory }}</p>
          <p>{{ info.provider }} {{ info.model }}</p>
          @if (info.workingDirectory) {
            <button type="button" (click)="newSession()" [disabled]="!online()">Start a new session in this project</button>
          }
        }
        <p>{{ hostName() }} · {{ online() ? 'Connected' : 'Offline' }} · Read-only</p>
      </details>
      <div class="scroll-wrap">
        <div #scrollEl class="transcript mobile-transcript" appCodeCopy (scroll)="onScroll()">
          @if (loading()) {
            <p class="muted">Loading…</p>
          }
          @if (error()) {
            <div class="load-error" role="alert">{{ error() }}
              <button type="button" (click)="load()" [disabled]="loading()">Retry</button>
            </div>
          }
          @if (!online() && messages().length) { <p class="muted">Showing the cached transcript.</p> }
          @if (messages().length > 0) {
            @for (item of displayItems(); track trackItem(item)) {
              @if (item.kind === 'stamp') {
                <div class="stamp">{{ item.label }}</div>
              } @else if (item.kind === 'tools') {
                <div class="tool-group">
                  <button
                    class="tool-toggle"
                    type="button"
                    (click)="toggleTools(item.id)"
                    [attr.aria-label]="toolGroupLabel(item)"
                    [attr.aria-expanded]="expandedTools().has(item.id)"
                  >
                    <app-mobile-icon
                      class="tool-caret"
                      [class.tool-caret--expanded]="expandedTools().has(item.id)"
                      name="chevron-down"
                    />
                    <app-mobile-icon name="tool" />
                    {{ item.items.length }} activity {{ item.items.length === 1 ? 'entry' : 'entries' }}
                  </button>
                  @if (expandedTools().has(item.id)) {
                    @for (t of item.items; track t.id) {
                      <details class="tool-entry">
                        <summary>{{ toolLabel(t) }}</summary>
                        <pre>{{ toolDetails(t) }}</pre>
                        <app-copy-button [text]="toolDetails(t)" />
                      </details>
                    }
                  }
                </div>
              } @else {
                <div
                  class="message"
                  [class]="'message ' + item.message.type"
                  [class.loop-output]="isLoopTranscriptMessage(item.message)"
                >
                  @if (item.message.type === 'error' || item.message.type === 'system') {
                    <span class="role">{{ roleLabel(item.message.type) }}</span>
                  }
                  <div
                    class="content markdown-body"
                    [class.loop-output]="isLoopTranscriptMessage(item.message)"
                    [innerHTML]="renderMarkdown(item.message.content)"
                  ></div>
                  @if (item.message.type !== 'system' && item.message.content) {
                    <app-copy-button [text]="item.message.content" />
                  }
                </div>
              }
            }
          }
          @if (!loading() && !error() && messages().length === 0) {
            <p class="muted">This session has no recorded messages.</p>
          }
        </div>

        @if (messages().length > 0) {
          <div class="scroll-btns">
            @if (!atTop()) {
              <button class="scroll-btn" (click)="scrollToTop()" aria-label="Scroll to top">
                <app-mobile-icon class="scroll-icon--up" name="chevron-down" />
              </button>
            }
            @if (!atBottom()) {
              <button class="scroll-btn" (click)="scrollToBottom()" aria-label="Scroll to bottom">
                <app-mobile-icon name="chevron-down" />
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
      .history-header { flex: none; padding: var(--space-2) var(--mobile-gutter) 0; }
      .scroll-wrap { flex: 1; position: relative; min-height: 0; display: flex; }
      .transcript { flex: 1; overflow-y: auto; padding: var(--space-4) var(--mobile-gutter); display: flex; flex-direction: column; gap: var(--space-3); }
      .scroll-btns {
        position: absolute; right: 12px; bottom: 12px; z-index: 4;
        display: flex; flex-direction: column; gap: 8px;
      }
      .scroll-btn {
        width: var(--control-size); height: var(--control-size); border-radius: 50%;
        border: 1px solid var(--separator);
        background: rgba(44, 44, 46, 0.92); color: var(--text);
        display: flex; align-items: center; justify-content: center;
        font-size: 1.1rem;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
      }
      .session-identity { flex: none; max-height: 35dvh; overflow: auto; padding-inline: var(--mobile-gutter); font-size: var(--font-size-sm); color: var(--text-secondary); overflow-wrap: anywhere; }
      .identity-feedback { flex: none; margin: var(--space-2) var(--mobile-gutter); color: var(--text-secondary); font-size: var(--font-size-sm); }
      .identity-feedback[role="alert"] { color: var(--accent-error); }
      .session-identity summary, .session-identity button, .load-error button, .identity-feedback button { min-height: var(--control-size); align-content: center; }
      .session-identity button, .load-error button, .identity-feedback button { border: 0; background: transparent; color: var(--accent-action); }
      .session-identity p { margin-block: var(--space-2); }
      .scroll-icon--up { transform: rotate(180deg); }
      .stamp { align-self: center; color: var(--text-secondary); font-size: 13px; text-align: center; }
      .tool-group { display: flex; flex-direction: column; gap: 4px; }
      .tool-toggle {
        min-height: var(--control-size); align-self: flex-start; display: flex; align-items: center; gap: 6px;
        background: none; border: none; color: var(--text-secondary);
        border-radius: var(--radius-sm); font-size: 13px; padding: 0 var(--space-2);
      }
      .tool-caret { font-size: 1rem; transition: transform var(--motion-press) ease-out; }
      .tool-caret--expanded { transform: rotate(180deg); }
      .muted { color: var(--text-secondary); text-align: center; margin-top: 40px; }
      .load-error { color: var(--accent-error); text-align: center; margin-top: 40px; }
    `,
  ],
})
export class HistoryDetailComponent {
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);
  private readonly hosts = inject(HostStore);
  private readonly browse = inject(MobileBrowseStateStore);
  private readonly origin = this.router.getCurrentNavigation()?.extras.state ?? window.history.state;
  private loadGeneration = 0;
  private identityGeneration = 0;
  protected readonly returnRoute = computed(() => this.browse.returnRoute(this.origin, '/history'));
  protected readonly online = this.gateway.online;
  protected readonly hostName = computed(() => this.hosts.activeHost()?.name || 'Host');
  protected readonly session = signal<MobileHistorySessionDto | null>(null);
  protected readonly identityLoading = signal(true);
  protected readonly identityError = signal<string | null>(null);

  /** Chat id from the route. */
  readonly chatId = input<string>('');

  protected readonly messages = signal<MobileMessageDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly renderMarkdown = renderMobileMarkdown;
  protected readonly isLoopTranscriptMessage = isLoopTranscriptMessage;
  protected readonly toolLabel = toolLabel;
  protected readonly toolDetails = toolDetails;

  /** Which collapsed tool groups the user has expanded (keyed by group id). */
  protected readonly expandedTools = signal<Set<string>>(new Set());

  protected readonly displayItems = computed<DisplayItem[]>(() => buildDisplayItems(this.messages()));

  protected trackItem(item: DisplayItem): string {
    return item.kind === 'msg' ? item.message.id : item.id;
  }

  protected toggleTools(id: string): void {
    this.expandedTools.update((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected toolGroupLabel(item: Extract<DisplayItem, { kind: 'tools' }>): string {
    return `Show ${item.items.length} activity ${item.items.length === 1 ? 'entry' : 'entries'}`;
  }

  /** Scroll-position flags driving the floating up/down buttons. */
  protected readonly atTop = signal(true);
  protected readonly atBottom = signal(true);
  /** Jump to the newest message only on the first render after messages load. */
  private didInitialScroll = false;

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scrollEl');

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.loadGeneration++; this.identityGeneration++; });
    effect(() => {
      this.chatId();
      this.hosts.activeHost();
      untracked(() => {
        this.messages.set([]);
        this.session.set(null);
        this.expandedTools.set(new Set());
        this.didInitialScroll = false;
        void this.load();
        void this.loadIdentity();
      });
    });
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

  protected async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    const hostId = this.hosts.activeHost()?.id;
    const chatId = this.chatId();
    const current = () => generation === this.loadGeneration && hostId === this.hosts.activeHost()?.id && chatId === this.chatId();
    this.loading.set(true);
    this.error.set(null);
    try {
      const messages = await this.gateway.historyMessages(chatId);
      if (current()) this.messages.set(messages);
    } catch {
      if (current()) this.error.set('The transcript could not be loaded. Check the host connection and try again.');
    } finally {
      if (current()) this.loading.set(false);
    }
  }

  protected async loadIdentity(): Promise<void> {
    const generation = ++this.identityGeneration;
    const hostId = this.hosts.activeHost()?.id;
    const chatId = this.chatId();
    const current = () => generation === this.identityGeneration && hostId === this.hosts.activeHost()?.id && chatId === this.chatId();
    this.identityLoading.set(true);
    this.identityError.set(null);
    const cached = this.gateway.dataHostId() === hostId ? this.gateway.historySessions().find((item) => item.id === chatId) : undefined;
    if (cached) this.session.set(cached);
    try {
      const sessions = await this.gateway.history();
      if (!current()) return;
      const session = sessions.find((item) => item.id === chatId);
      if (session) this.session.set(session);
      else this.identityError.set('Session details could not be found on this host. Try refreshing them.');
    } catch {
      if (current()) this.identityError.set('Session details could not be loaded. Check the host connection and try again.');
    } finally {
      if (current()) this.identityLoading.set(false);
    }
  }

  protected newSession(): void {
    const directory = this.session()?.workingDirectory;
    if (!directory || !this.online()) return;
    void this.router.navigate(['/new-session'], {
      queryParams: { dir: directory },
      state: { ...this.browse.navigationState(this.returnRoute()), ...newSessionPresetState(this.hosts.activeHost()?.id, directory) },
    });
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
    void this.router.navigate([this.returnRoute()]);
  }
}
