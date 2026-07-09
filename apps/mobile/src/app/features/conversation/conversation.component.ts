import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
import { DraftStore } from '../../core/draft-store';
import { GatewayClient } from '../../core/gateway-client.service';
import { HapticsService } from '../../core/haptics.service';
import { ImageAttachmentService } from '../../core/image-attachment.service';
import { VoiceInputService } from '../../core/voice-input.service';
import { isWorking, statusColor, statusLabel } from '../../core/status';
import type { MobileAttachmentDto, MobileModelCatalog } from '../../core/models';
import { CodeCopyDirective } from '../../shared/code-copy.directive';
import { CopyButtonComponent } from '../../shared/copy-button.component';
import { ModelSheetComponent } from '../../shared/model-sheet.component';
import { renderMobileMarkdown } from '../../shared/mobile-markdown';
import {
  buildDisplayItems,
  isLoopTranscriptMessage,
  toolLabel,
  type DisplayItem,
} from '../../shared/transcript-items';

/**
 * One agent's live conversation: transcript (replayed history + live stream),
 * a status/context header, an input bar, and Stop/terminate controls. Approval
 * prompts surface through the global approval sheet (app.component).
 */
@Component({
  standalone: true,
  selector: 'app-conversation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ModelSheetComponent, CopyButtonComponent, CodeCopyDirective],
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
        <span class="status-text">{{ label(status()) }}</span>
        @if (instance()?.contextPercentage !== undefined) {
          <span class="ctx">· context {{ instance()?.contextPercentage }}%</span>
        }
        @if (instance()?.model) {
          <span class="model">· {{ instance()?.model }}</span>
        }
        @if (!online()) {
          <span class="offline">· offline</span>
        }
      </div>

      @if (menuOpen()) {
        <div class="popover">
          <button (click)="rename()">Rename</button>
          <button (click)="openModelSheet()" [disabled]="!online() || !instance()">Change model…</button>
          <button (click)="interrupt()" [disabled]="!online()">Stop (interrupt)</button>
          <button class="danger" (click)="terminate()" [disabled]="!online()">Terminate</button>
        </div>
      }

      <div class="scroll-wrap">
        <div
          #scrollEl
          class="transcript"
          appCodeCopy
          (scroll)="onScroll()"
          (touchstart)="onTouchStart()"
          (touchend)="onTouchEnd()"
          (touchcancel)="onTouchEnd()"
        >
          @for (item of displayItems(); track trackItem(item)) {
            @if (item.kind === 'stamp') {
              <div class="stamp">{{ item.label }}</div>
            } @else if (item.kind === 'tools') {
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
              <div
                class="msg"
                [class]="'t-' + item.message.type"
                [class.loop-output]="isLoopTranscriptMessage(item.message)"
              >
                <div
                  class="bubble markdown-body"
                  [class.loop-output]="isLoopTranscriptMessage(item.message)"
                  [innerHTML]="renderMarkdown(item.message.content)"
                ></div>
                @if (item.message.hasAttachments) {
                  <span class="attach-flag">📎 photo attached</span>
                }
                @if (item.message.type !== 'system' && item.message.content) {
                  <app-copy-button [text]="item.message.content" />
                }
              </div>
            }
          } @empty {
            <p class="muted center">{{ online() ? 'No messages yet.' : 'Connecting…' }}</p>
          }
          @if (working()) {
            <div class="typing" role="status" aria-label="Agent is working">
              <span></span><span></span><span></span>
            </div>
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
              <button
                class="scroll-btn"
                [class.new-output]="hasNewOutput()"
                (click)="scrollToBottom()"
                aria-label="Scroll to bottom"
              >
                @if (hasNewOutput()) {
                  <span class="pill-label">New output</span>
                }
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
            }
          </div>
        }
      </div>

      @if (attachments().length > 0) {
        <div class="attach-strip">
          @for (a of attachments(); track a) {
            <div class="chip">
              <img [src]="a.data" [alt]="a.name" />
              <button type="button" class="chip-x" (click)="removeAttachment(a)" aria-label="Remove">×</button>
            </div>
          }
        </div>
      }

      <form class="composer" (submit)="send($event)">
        @if (canAttach) {
          <button
            type="button"
            class="attach"
            (click)="pickImages()"
            [disabled]="attachBusy() || sending()"
            aria-label="Add photo"
          >
            {{ attachBusy() ? '…' : '＋' }}
          </button>
          <button
            type="button"
            class="attach"
            (click)="pasteImageFromClipboard()"
            [disabled]="attachBusy() || sending()"
            aria-label="Paste image from clipboard"
          >
            @if (attachBusy()) {
              …
            } @else {
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 4h6a2 2 0 0 1 2 2v1h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-1H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3h3v1Z" />
                <path d="M8 7h10v11H8V7Z" />
                <path d="M7 4h10" />
              </svg>
            }
          </button>
        }
        <textarea
          rows="1"
          [ngModel]="draft()"
          (ngModelChange)="draft.set($event)"
          [ngModelOptions]="{ standalone: true }"
          placeholder="Message…"
          (keydown.enter)="onEnter($event)"
          (paste)="onPaste($event)"
        ></textarea>
        @if (canDictate) {
          <button
            type="button"
            class="attach mic"
            [class.listening]="listening()"
            (click)="toggleDictation()"
            [attr.aria-label]="listening() ? 'Stop dictation' : 'Dictate'"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z" />
              <path d="M19 11a7 7 0 0 1-14 0" />
              <path d="M12 18v4" />
            </svg>
          </button>
        }
        <button type="submit" class="send" [disabled]="!online() || !canSend() || sending()">
          {{ sending() ? '…' : '↑' }}
        </button>
      </form>

      @if (modelSheetOpen()) {
        <app-model-sheet
          [provider]="instance()?.provider ?? ''"
          [models]="modelsForProvider()"
          [selected]="instance()?.model"
          [includeDefault]="false"
          [loading]="modelsLoading() || changingModel()"
          [error]="modelsError()"
          (choose)="chooseModel($event)"
          (dismiss)="modelSheetOpen.set(false)"
        />
      }
    </section>
  `,
  styleUrls: ['./conversation.component.scss'],
})
export class ConversationComponent {
  private readonly gateway = inject(GatewayClient);
  private readonly images = inject(ImageAttachmentService);
  private readonly drafts = inject(DraftStore);
  private readonly haptics = inject(HapticsService);
  private readonly voice = inject(VoiceInputService);
  private readonly router = inject(Router);

  readonly projectKey = input<string>('');
  readonly instanceId = input<string>('');

  protected readonly draft = signal('');
  protected readonly attachments = signal<MobileAttachmentDto[]>([]);
  protected readonly attachBusy = signal(false);
  protected readonly canAttach = this.images.available;
  protected readonly canDictate = this.voice.available;
  protected readonly listening = this.voice.listening;
  protected readonly sending = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly modelSheetOpen = signal(false);
  protected readonly modelsLoading = signal(false);
  protected readonly changingModel = signal(false);
  protected readonly modelsError = signal<string | null>(null);
  protected readonly modelCatalog = signal<MobileModelCatalog | null>(null);
  protected readonly online = this.gateway.online;
  protected readonly color = statusColor;
  protected readonly label = statusLabel;
  protected readonly renderMarkdown = renderMobileMarkdown;
  protected readonly isLoopTranscriptMessage = isLoopTranscriptMessage;
  protected readonly toolLabel = toolLabel;

  /** Scroll-position flags driving the floating up/down buttons + auto-follow. */
  protected readonly atTop = signal(true);
  protected readonly atBottom = signal(true);
  /** New messages arrived while the user was reading scrolled-up history. */
  protected readonly hasNewOutput = signal(false);
  /** Don't auto-follow new messages while the user is reading scrolled-up history. */
  private stickToBottom = true;
  /** Finger is on the transcript — never fight an active touch with auto-scroll. */
  private touching = false;
  private prevMessageCount = 0;
  /** Session the current draft belongs to; '' suspends draft persistence. */
  private draftKeyId = '';

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scrollEl');

  protected readonly instance = computed(() =>
    this.gateway.snapshot()?.instances.find((i) => i.id === this.instanceId()),
  );
  protected readonly status = computed(() => this.instance()?.status ?? 'idle');
  protected readonly working = computed(() => isWorking(this.status()));
  protected readonly messages = computed(() => this.gateway.messagesFor(this.instanceId()));
  protected readonly modelsForProvider = computed(() => {
    const provider = this.instance()?.provider;
    return provider ? this.modelCatalog()?.[provider] ?? [] : [];
  });

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

  constructor() {
    // Tell the gateway which conversation is open so it won't flag the unread
    // completion dot for a session the user is actively watching. Cleared when
    // the component is torn down (back to the list / different screen).
    effect(() => {
      this.gateway.setActiveView(this.instanceId() || null);
    });
    inject(DestroyRef).onDestroy(() => {
      this.gateway.clearActiveView(this.instanceId());
      if (this.voice.listening()) void this.voice.stop();
    });

    // Mirror live dictation into the draft while the recognizer is running.
    effect(() => {
      if (this.voice.listening()) {
        this.draft.set(this.voice.text());
      }
    });

    // Restore the persisted unsent draft for this session (survives iOS
    // evicting the app). Persistence is suspended while swapping sessions so
    // the old text can't leak into the new session's draft key.
    effect(() => {
      const id = this.instanceId();
      if (!id || id === this.draftKeyId) return;
      const hadPrevious = this.draftKeyId !== '';
      this.draftKeyId = '';
      const pending = this.drafts.load(`instance:${id}`);
      if (hadPrevious) this.draft.set('');
      void pending.then((text) => {
        this.draftKeyId = id;
        if (text && !this.draft().trim()) this.draft.set(text);
      });
    });
    // Persist every draft change (debounced in the store). Sending clears the
    // draft signal, which clears the stored draft through this same path.
    effect(() => {
      const text = this.draft();
      if (this.draftKeyId) this.drafts.save(`instance:${this.draftKeyId}`, text);
    });

    // Load (and resync on reconnect) the transcript for the open instance.
    effect(() => {
      const id = this.instanceId();
      if (id && this.gateway.online()) {
        void this.gateway.loadMessages(id);
      }
    });
    // Auto-scroll to the newest message — but only while the user is parked at
    // the bottom. If they've scrolled up to read history, leave them there and
    // surface a "New output" pill instead of yanking the view down.
    effect(() => {
      const count = this.messages().length;
      // The typing indicator adds height at the tail; keep following it too.
      void this.working();
      const grew = count > this.prevMessageCount;
      this.prevMessageCount = count;
      // Track the viewChild too: on a one-shot history load the effect can fire
      // before the transcript element exists; re-run once it resolves so we still
      // scroll to the bottom and surface the floating buttons.
      const el = this.scrollEl()?.nativeElement;
      if (!el) return;
      queueMicrotask(() => {
        if (this.stickToBottom && !this.touching) {
          el.scrollTop = el.scrollHeight;
        } else if (grew) {
          this.hasNewOutput.set(true);
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
    if (bottom) {
      this.hasNewOutput.set(false);
    }
  }

  protected onScroll(): void {
    this.updateScrollFlags();
  }

  /**
   * Break the bottom-pin the instant a finger lands on the transcript, so a
   * streaming update can never yank the view down mid-gesture. The pin
   * re-engages on release if the view settled back at the bottom.
   */
  protected onTouchStart(): void {
    this.touching = true;
    this.stickToBottom = false;
  }

  protected onTouchEnd(): void {
    this.touching = false;
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

  protected onEnter(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (!keyboard.shiftKey) {
      event.preventDefault();
      void this.send(event);
    }
  }

  /** Send is allowed with text, attachments, or both. */
  protected canSend(): boolean {
    return this.draft().trim().length > 0 || this.attachments().length > 0;
  }

  protected async pickImages(): Promise<void> {
    if (this.attachBusy()) return;
    this.attachBusy.set(true);
    try {
      const picked = await this.images.pickImages();
      if (picked.length) {
        this.attachments.update((current) => [...current, ...picked]);
      }
    } catch {
      /* user cancelled or the pick failed — nothing to add */
    } finally {
      this.attachBusy.set(false);
    }
  }

  protected async pasteImageFromClipboard(): Promise<void> {
    if (this.attachBusy()) return;
    this.attachBusy.set(true);
    try {
      const pasted = await this.images.pasteImageFromClipboard();
      if (pasted) {
        this.attachments.update((current) => [...current, pasted]);
      }
    } catch {
      /* paste denied or unsupported — nothing to add */
    } finally {
      this.attachBusy.set(false);
    }
  }

  protected async onPaste(event: ClipboardEvent): Promise<void> {
    if (this.attachBusy()) return;
    this.attachBusy.set(true);
    try {
      const pasted = await this.images.attachmentsFromPasteEvent(event);
      if (pasted.length) {
        this.attachments.update((current) => [...current, ...pasted]);
      }
    } catch {
      /* browser paste data can vary by platform */
    } finally {
      this.attachBusy.set(false);
    }
  }

  protected removeAttachment(attachment: MobileAttachmentDto): void {
    this.attachments.update((current) => current.filter((a) => a !== attachment));
  }

  protected async toggleDictation(): Promise<void> {
    if (this.voice.listening()) {
      await this.voice.stop();
      this.draft.set(this.voice.text());
      this.haptics.tap();
      return;
    }
    this.haptics.tap();
    const started = await this.voice.start(this.draft());
    if (!started) this.haptics.error();
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    if (this.voice.listening()) {
      await this.voice.stop();
      this.draft.set(this.voice.text());
    }
    const text = this.draft().trim();
    const attachments = this.attachments();
    if ((!text && attachments.length === 0) || this.sending() || !this.online()) return;
    this.haptics.tap();
    this.sending.set(true);
    this.draft.set('');
    this.attachments.set([]);
    try {
      await this.gateway.sendInput(
        this.instanceId(),
        text,
        attachments.length ? attachments : undefined,
      );
    } catch {
      // Restore the draft + attachments so the user doesn't lose them.
      this.haptics.error();
      this.draft.set(text);
      this.attachments.set(attachments);
    } finally {
      this.sending.set(false);
    }
  }

  protected async interrupt(): Promise<void> {
    this.menuOpen.set(false);
    this.haptics.heavyTap();
    try {
      await this.gateway.interrupt(this.instanceId());
    } catch {
      /* surfaced via status */
    }
  }

  protected async terminate(): Promise<void> {
    this.menuOpen.set(false);
    if (!confirm('Terminate this session?')) return;
    this.haptics.heavyTap();
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

  protected async openModelSheet(): Promise<void> {
    this.menuOpen.set(false);
    if (!this.instance()) return;
    this.modelSheetOpen.set(true);
    if (this.modelCatalog() || this.modelsLoading()) return;
    this.modelsLoading.set(true);
    this.modelsError.set(null);
    try {
      this.modelCatalog.set(await this.gateway.models());
    } catch (err) {
      this.modelsError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.modelsLoading.set(false);
    }
  }

  protected async chooseModel(model: string | undefined): Promise<void> {
    this.modelSheetOpen.set(false);
    if (!model || this.changingModel()) return;
    this.changingModel.set(true);
    try {
      await this.gateway.changeModel(this.instanceId(), model);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      this.changingModel.set(false);
    }
  }

  protected back(): void {
    void this.router.navigate(['/projects', this.projectKey(), 'sessions']);
  }
}
