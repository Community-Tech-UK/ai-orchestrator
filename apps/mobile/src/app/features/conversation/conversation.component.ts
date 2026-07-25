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
import {
  displayStatusColor,
  displayStatusLabel,
  isInterruptRecovery,
  isWorkingOrLooping,
} from '../../core/status';
import type {
  MobileAttachmentDto,
  MobileModelCatalog,
  MobileQueuedMessageDto,
} from '../../core/models';
import { ComposerQueueComponent } from './composer-queue.component';
import { CodeCopyDirective } from '../../shared/code-copy.directive';
import { CopyButtonComponent } from '../../shared/copy-button.component';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { ModelSheetComponent } from '../../shared/model-sheet.component';
import { renderMobileMarkdown } from '../../shared/mobile-markdown';
import {
  buildDisplayItems,
  isLoopTranscriptMessage,
  toolLabel,
  type DisplayItem,
} from '../../shared/transcript-items';

/** How long a composer notice (queued / stopping / failed) stays on screen. */
const NOTICE_TIMEOUT_MS = 6000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One agent's live conversation: transcript (replayed history + live stream),
 * a status/context header, an input bar, and Stop/terminate controls. Approval
 * prompts surface through the global approval sheet (app.component).
 */
@Component({
  standalone: true,
  selector: 'app-conversation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ComposerQueueComponent,
    ModelSheetComponent,
    CopyButtonComponent,
    CodeCopyDirective,
    MobileHeaderComponent,
    MobileIconComponent,
  ],
  templateUrl: './conversation.component.html',
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
  protected readonly interrupting = signal(false);
  /** Transient one-line feedback above the composer (queued / stopped / failed). */
  protected readonly notice = signal<string | null>(null);
  protected readonly noticeIsError = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly modelSheetOpen = signal(false);
  protected readonly modelsLoading = signal(false);
  protected readonly changingModel = signal(false);
  protected readonly modelsError = signal<string | null>(null);
  protected readonly modelCatalog = signal<MobileModelCatalog | null>(null);
  protected readonly online = this.gateway.online;
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
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scrollEl');

  protected readonly instance = computed(() =>
    this.gateway.snapshot()?.instances.find((i) => i.id === this.instanceId()),
  );
  protected readonly activityColor = computed(() => displayStatusColor(this.instance()));
  protected readonly activityLabel = computed(() => displayStatusLabel(this.instance()));
  protected readonly headerSubtitle = computed(() => {
    const detail = [
      this.activityLabel(),
      this.instance()?.contextPercentage === undefined
        ? ''
        : `context ${this.instance()?.contextPercentage}%`,
      this.instance()?.model ?? '',
      this.online() ? '' : 'offline',
    ].filter(Boolean);
    return detail.join(' · ');
  });
  protected readonly working = computed(() => isWorkingOrLooping(this.instance()));
  protected readonly messages = computed(() => this.gateway.messagesFor(this.instanceId()));
  /** Messages the host is holding until this session can accept input again. */
  protected readonly queued = computed(() => this.instance()?.queuedMessages ?? []);
  /** An interrupt is already settling — a second one would cancel the session. */
  protected readonly stopping = computed(() => isInterruptRecovery(this.instance()?.status ?? ''));
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

  protected toolGroupLabel(item: Extract<DisplayItem, { kind: 'tools' }>): string {
    return `Show ${item.items.length} tool ${item.items.length === 1 ? 'call' : 'calls'}`;
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
      clearTimeout(this.noticeTimer);
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
    this.clearNotice();
    try {
      const result = await this.gateway.sendInput(
        this.instanceId(),
        text,
        attachments.length ? attachments : undefined,
      );
      if (result.queued) {
        this.showNotice('Queued — it will send when this session is free.');
      }
    } catch (err) {
      // Restore the draft + attachments so the user doesn't lose them, and say
      // why: a silent restore reads as the message having been sent twice.
      this.haptics.error();
      this.draft.set(text);
      this.attachments.set(attachments);
      this.showNotice(`Not sent: ${errorText(err)}`, true);
    } finally {
      this.sending.set(false);
    }
  }

  /**
   * Stop the running turn. From the menu (`escalate`) a second stop while the
   * session is already settling force-cancels it on the host, so that path
   * confirms first; the composer button is simply disabled while settling.
   */
  protected async interrupt(escalate = false): Promise<void> {
    this.menuOpen.set(false);
    if (this.interrupting()) return;
    if (this.stopping()) {
      if (!escalate) return;
      if (!confirm('This session is already stopping. Force-cancel it? The session ends.')) return;
    }
    this.haptics.heavyTap();
    this.interrupting.set(true);
    this.clearNotice();
    try {
      const { accepted } = await this.gateway.interrupt(this.instanceId());
      if (accepted) {
        this.showNotice('Stopping…');
      } else {
        this.haptics.error();
        this.showNotice('Nothing to stop — this session is not running a turn.', true);
      }
    } catch (err) {
      this.haptics.error();
      this.showNotice(`Stop failed: ${errorText(err)}`, true);
    } finally {
      this.interrupting.set(false);
    }
  }

  /** Cancel a queued message and put its text back in the composer. */
  protected async cancelQueued(item: MobileQueuedMessageDto): Promise<void> {
    this.haptics.tap();
    try {
      const restored = await this.gateway.cancelQueued(this.instanceId(), item.id);
      const text = restored || item.message;
      // Never lose the text: append when the composer is already in use.
      this.draft.update((current) => (current.trim() ? `${current.trimEnd()}\n${text}` : text));
    } catch (err) {
      this.showNotice(`Could not cancel: ${errorText(err)}`, true);
    }
  }

  private showNotice(text: string, isError = false): void {
    this.notice.set(text);
    this.noticeIsError.set(isError);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(null), NOTICE_TIMEOUT_MS);
  }

  private clearNotice(): void {
    clearTimeout(this.noticeTimer);
    this.notice.set(null);
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
