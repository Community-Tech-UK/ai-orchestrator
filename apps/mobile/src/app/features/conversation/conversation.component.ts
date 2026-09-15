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
  afterRenderEffect,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  connectionHeadline,
  connectionLabel,
  emptyTranscriptText,
} from '../../core/connection-status';
import { DraftStore } from '../../core/draft-store';
import { ConversationDraftRecoveryService, joinDraftText } from '../../core/conversation-draft-recovery.service';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import { ApprovalPresentationStore } from '../../core/approval-presentation.store';
import { MobileBrowseStateStore } from '../../core/mobile-browse-state.store';
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
import { MobileSheetComponent } from '../../shared/mobile-sheet.component';
import { ModelSheetComponent } from '../../shared/model-sheet.component';
import { renderMobileMarkdown } from '../../shared/mobile-markdown';
import {
  buildDisplayItems,
  isLoopTranscriptMessage,
  toolLabel,
  toolDetails,
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
    MobileSheetComponent,
  ],
  templateUrl: './conversation.component.html',
  styleUrls: ['./conversation.component.scss'],
})
export class ConversationComponent {
  private readonly gateway = inject(GatewayClient);
  private readonly images = inject(ImageAttachmentService);
  private readonly drafts = inject(DraftStore);
  private readonly recovery = inject(ConversationDraftRecoveryService);
  private readonly haptics = inject(HapticsService);
  private readonly voice = inject(VoiceInputService);
  private readonly router = inject(Router);
  private readonly hosts = inject(HostStore);
  private readonly browse = inject(MobileBrowseStateStore);
  protected readonly approvals = inject(ApprovalPresentationStore);
  private readonly origin = this.router.getCurrentNavigation()?.extras.state ?? window.history.state;
  protected readonly returnRoute = computed(() => this.browse.returnRoute(this.origin));
  protected readonly hostName = computed(() => this.hosts.activeHost()?.name ?? 'Host');
  protected readonly requests = computed(() => this.approvals.requests().filter((p) => p.instanceId === this.instanceId()));

  readonly projectKey = input<string>('');
  readonly instanceId = input<string>('');

  protected readonly draft = signal('');
  protected readonly legacyDraftAvailable = signal(false);
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
  protected readonly detailsOpen = signal(false);
  protected readonly queuePending = signal<string | null>(null);
  protected pendingModel: string | undefined;
  protected readonly modelsLoading = signal(false);
  protected readonly changingModel = signal(false);
  protected readonly modelsError = signal<string | null>(null);
  protected readonly modelCatalog = signal<MobileModelCatalog | null>(null);
  protected readonly online = this.gateway.online;
  /** Distinguishes an expired pairing from an ordinary network drop. */
  protected readonly connectionHeadline = computed(() => connectionHeadline(this.gateway.state()));
  protected readonly transcriptState = computed(() => this.gateway.messageStateFor(this.instanceId()));
  protected readonly emptyTranscript = computed(() => {
    const state = this.transcriptState();
    if (state.status === 'loading') return 'Loading conversation…';
    if (state.status === 'error') return 'The conversation could not be loaded.';
    if (state.status === 'idle' && this.online()) return 'Waiting to load this conversation…';
    return emptyTranscriptText(this.gateway.state());
  });
  protected readonly renderMarkdown = renderMobileMarkdown;
  protected readonly isLoopTranscriptMessage = isLoopTranscriptMessage;
  protected readonly toolLabel = toolLabel;
  protected readonly toolDetails = toolDetails;

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
  private readonly draftKeyId = signal('');
  private loadingDraftKey = '';
  private readonly contextKey = computed(() => JSON.stringify(['instance', this.hosts.activeHost()?.id ?? '', this.instanceId()]));
  private draftGeneration = 0;
  private detachDraft: (() => void) | undefined;
  private destroyed = false;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scrollEl');
  private readonly draftEl = viewChild<ElementRef<HTMLTextAreaElement>>('draftEl');

  protected readonly instance = computed(() =>
    this.gateway.dataHostId() === this.hosts.activeHost()?.id
      ? this.gateway.snapshot()?.instances.find((i) => i.id === this.instanceId()) : undefined,
  );
  protected readonly activityColor = computed(() => displayStatusColor(this.instance()));
  protected readonly activityLabel = computed(() => displayStatusLabel(this.instance()));
  protected readonly headerSubtitle = computed(() => {
    const detail = [this.activityLabel(), this.online() ? '' : connectionLabel(this.gateway.state())].filter(Boolean);
    return detail.join(' · ');
  });
  protected readonly working = computed(() => isWorkingOrLooping(this.instance()));
  protected readonly messages = computed(() => this.gateway.dataHostId() === this.hosts.activeHost()?.id
    ? this.gateway.messagesFor(this.instanceId()) : []);
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
    return `Show ${item.items.length} activity ${item.items.length === 1 ? 'entry' : 'entries'}`;
  }

  constructor() {
    // Tell the gateway which conversation is open so it won't flag the unread
    // completion dot for a session the user is actively watching. Cleared when
    // the component is torn down (back to the list / different screen).
    effect(() => {
      this.gateway.setActiveView(this.instanceId() || null);
    });
    inject(DestroyRef).onDestroy(() => {
      this.persistDraftOnExit();
      this.detachDraft?.();
      this.destroyed = true;
      this.draftGeneration++;
      this.gateway.clearActiveView(this.instanceId());
      clearTimeout(this.noticeTimer);
      void this.voice.stop();
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
      const key = this.contextKey();
      untracked(() => {
        const generation = ++this.draftGeneration;
        this.detachDraft?.();
        void this.voice.stop();
        this.persistDraftOnExit();
        this.loadingDraftKey = key;
        this.draftKeyId.set('');
        this.draft.set('');
        this.attachments.set(this.drafts.attachments(key));
        this.modelCatalog.set(null);
        this.modelSheetOpen.set(false);
        this.menuOpen.set(false);
        this.detailsOpen.set(false);
        this.pendingModel = undefined;
        this.modelsError.set(null);
        this.attachBusy.set(false);
        this.legacyDraftAvailable.set(false);
        this.modelsLoading.set(false);
        this.changingModel.set(false);
        this.sending.set(false);
        this.interrupting.set(false);
        this.queuePending.set(null);
        this.clearNotice();
        this.expandedTools.set(new Set());
        this.stickToBottom = true;
        this.prevMessageCount = 0;
        const ready = this.drafts.load(key).then((text) => {
          if (this.destroyed || generation !== this.draftGeneration) return;
          if (text) this.draft.update((draft) => joinDraftText(draft, text));
          this.loadingDraftKey = '';
          this.draftKeyId.set(key);
        });
        this.detachDraft = this.recovery.attach(key, async (text, attachments) => {
          await ready;
          if (this.destroyed || generation !== this.draftGeneration || key !== this.contextKey()) return false;
          this.draft.update((draft) => joinDraftText(draft, text));
          this.attachments.update((current) => [...current, ...attachments]);
          this.persistDraft();
          return true;
        });
        void this.drafts.load(`instance:${this.instanceId()}`).then((text) => {
          if (!this.destroyed && generation === this.draftGeneration) this.legacyDraftAvailable.set(!!text);
        });
      });
    });
    // Persist every draft change (debounced in the store). Sending clears the
    // draft signal, which clears the stored draft through this same path.
    effect(() => {
      this.persistDraft();
    });

    // Load (and resync on reconnect) the transcript for the open instance.
    effect(() => {
      const id = this.instanceId();
      if (id && this.gateway.online() && this.gateway.dataHostId() === this.hosts.activeHost()?.id) {
        void this.gateway.loadMessages(id);
      }
    });
    afterRenderEffect(() => {
      this.draft();
      const element = this.draftEl()?.nativeElement;
      if (!element) return;
      // NgModel applies recovered text in a microtask after this render.
      queueMicrotask(() => {
        if (this.destroyed || !element.isConnected) return;
        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, Math.max(72, window.innerHeight * 0.22))}px`;
      });
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
    if (!keyboard.isComposing && keyboard.keyCode !== 229 && (keyboard.metaKey || keyboard.ctrlKey)) {
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
    const key = this.contextKey();
    const current = this.operationScope();
    this.attachBusy.set(true);
    try {
      const picked = await this.images.pickImages();
      if (picked.length) {
        await this.restoreDraft(key, '', picked);
      }
    } catch (error) {
      if (current()) this.showNotice(errorText(error), true);
    } finally {
      if (current()) this.attachBusy.set(false);
    }
  }

  protected async pasteImageFromClipboard(): Promise<void> {
    if (this.attachBusy()) return;
    const key = this.contextKey();
    const current = this.operationScope();
    this.attachBusy.set(true);
    try {
      const pasted = await this.images.pasteImageFromClipboard();
      if (pasted) {
        await this.restoreDraft(key, '', [pasted]);
      } else if (current()) {
        this.showNotice('No image was found. Copy an image first or use Add photo.', true);
      }
    } catch (error) {
      if (current()) this.showNotice(errorText(error), true);
    } finally {
      if (current()) this.attachBusy.set(false);
    }
  }

  protected async onPaste(event: ClipboardEvent): Promise<void> {
    if (this.attachBusy()) return;
    const key = this.contextKey();
    const current = this.operationScope();
    this.attachBusy.set(true);
    try {
      const pasted = await this.images.attachmentsFromPasteEvent(event);
      if (pasted.length) {
        await this.restoreDraft(key, '', pasted);
      }
    } catch (error) {
      if (current()) this.showNotice(errorText(error), true);
    } finally {
      if (current()) this.attachBusy.set(false);
    }
  }

  protected removeAttachment(attachment: MobileAttachmentDto): void {
    this.attachments.update((current) => current.filter((a) => a !== attachment));
  }

  protected async toggleDictation(): Promise<void> {
    const current = this.operationScope();
    if (this.voice.listening()) {
      const text = this.voice.text();
      const stopped = this.voice.stop();
      this.draft.set(text);
      await stopped;
      if (!current()) return;
      this.haptics.tap();
      return;
    }
    this.haptics.tap();
    const started = await this.voice.start(this.draft());
    if (!current()) return;
    if (!started) {
      this.haptics.error();
      this.showNotice('Dictation could not start. Allow microphone and speech access in device Settings, or type your message.', true);
    }
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSend() || this.sending() || !this.online()) return;
    const key = this.contextKey();
    const id = this.instanceId();
    const current = this.operationScope();
    this.sending.set(true);
    let text = '';
    let attachments: MobileAttachmentDto[] = [];
    try {
      text = (this.voice.listening() ? this.voice.text() : this.draft()).trim();
      attachments = this.attachments();
      const stopped = this.voice.listening() ? this.voice.stop() : null;
      this.haptics.tap();
      this.draft.set('');
      this.attachments.set([]);
      this.persistDraft();
      this.clearNotice();
      if (stopped) await stopped;
      if (!current()) { await this.restoreDraft(key, text, attachments); return; }
      const result = await this.gateway.sendInput(
        id,
        text,
        attachments.length ? attachments : undefined,
      );
      if (current() && result.queued) {
        this.showNotice('Queued. It will send when this session is free.');
      }
    } catch (err) {
      // Restore the draft + attachments so the user doesn't lose them, and say
      // why: a silent restore reads as the message having been sent twice.
      await this.restoreDraft(key, text, attachments);
      if (current()) {
        this.haptics.error();
        this.showNotice(`Send not confirmed: ${errorText(err)}`, true);
      }
    } finally {
      if (current()) this.sending.set(false);
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
    const current = this.operationScope();
    this.clearNotice();
    try {
      const { accepted } = await this.gateway.interrupt(this.instanceId());
      if (!current()) return;
      if (accepted) {
        this.showNotice('Stopping…');
      } else {
        this.haptics.error();
        this.showNotice('Nothing to stop — this session is not running a turn.', true);
      }
    } catch (err) {
      if (!current()) return;
      this.haptics.error();
      this.showNotice(`Stop failed: ${errorText(err)}`, true);
    } finally {
      if (current()) this.interrupting.set(false);
    }
  }

  /** Return queued content without replacing an already active draft. */
  protected async cancelQueued(item: MobileQueuedMessageDto, remove = false): Promise<void> {
    if (this.queuePending()) return;
    const key = this.contextKey();
    const current = this.operationScope();
    this.queuePending.set(item.id);
    this.haptics.tap();
    try {
      const restored = await this.gateway.cancelQueued(this.instanceId(), item.id);
      if (!remove) await this.restoreDraft(key, restored.message, restored.attachments ?? []);
      if (current()) this.showNotice(remove ? 'Queued message removed.' : 'Queued message added to your draft.');
    } catch (err) {
      if (current()) this.showNotice(`Could not change the queue: ${errorText(err)}`, true);
    } finally {
      if (current()) this.queuePending.set(null);
    }
  }

  private showNotice(text: string, isError = false): void {
    this.notice.set(text);
    this.noticeIsError.set(isError);
    clearTimeout(this.noticeTimer);
    if (!isError) this.noticeTimer = setTimeout(() => this.notice.set(null), NOTICE_TIMEOUT_MS);
  }

  protected clearNotice(): void {
    clearTimeout(this.noticeTimer);
    this.notice.set(null);
  }

  protected async terminate(): Promise<void> {
    this.menuOpen.set(false);
    if (!confirm('Close this session? The agent stops and unsaved work is lost.')) return;
    this.haptics.heavyTap();
    const current = this.operationScope();
    try {
      await this.gateway.terminate(this.instanceId());
      if (current()) this.back();
    } catch (err) {
      if (!current()) return;
      // Was silent, so a rejected token made this look like a dead button. Match
      // the notice pattern the send/stop/cancel actions already use.
      this.haptics.error();
      this.showNotice(`Close failed: ${errorText(err)}`, true);
    }
  }

  protected async rename(): Promise<void> {
    this.menuOpen.set(false);
    const name = prompt('Rename session', this.instance()?.displayName ?? '');
    if (name && name.trim()) {
      const current = this.operationScope();
      try {
        await this.gateway.rename(this.instanceId(), name.trim());
      } catch (err) {
        if (!current()) return;
        this.haptics.error();
        this.showNotice(`Rename failed: ${errorText(err)}`, true);
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
    const current = this.operationScope();
    try {
      const catalog = await this.gateway.models();
      if (current()) this.modelCatalog.set(catalog);
    } catch (err) {
      if (current()) this.modelsError.set(errorText(err));
    } finally {
      if (current()) this.modelsLoading.set(false);
    }
  }

  protected async chooseModel(model: string | undefined): Promise<void> {
    if (!model || this.changingModel()) return;
    const current = this.operationScope();
    this.pendingModel = model;
    this.modelsError.set(null);
    this.changingModel.set(true);
    try {
      await this.gateway.changeModel(this.instanceId(), model);
      if (current()) {
        this.pendingModel = undefined;
        this.haptics.success();
        this.modelSheetOpen.set(false);
      }
    } catch (err) {
      if (current()) this.modelsError.set(`Model change not confirmed: ${errorText(err)}`);
    } finally {
      if (current()) this.changingModel.set(false);
    }
  }

  protected retryModel(): void {
    if (this.pendingModel) void this.chooseModel(this.pendingModel);
    else void this.openModelSheet();
  }

  protected retryTranscript(): void { void this.gateway.loadMessages(this.instanceId()); }
  protected reconnect(): void { this.gateway.reconnect(); }
  protected changeHost(): void { void this.router.navigate(['/hosts']); }
  protected pairAgain(): void { void this.router.navigate(['/add-host']); }
  protected readonly pairingExpired = computed(() => this.gateway.state() === 'unauthorized');

  private operationScope(): () => boolean {
    const key = this.contextKey();
    const generation = this.draftGeneration;
    return () => !this.destroyed && key === this.contextKey() && generation === this.draftGeneration;
  }

  private persistDraft(): void {
    const key = this.draftKeyId();
    const text = this.draft();
    const attachments = this.attachments();
    if (!key) return;
    this.drafts.save(key, text);
    this.drafts.saveAttachments(key, attachments);
  }

  private persistDraftOnExit(): void {
    if (!this.loadingDraftKey) { this.persistDraft(); return; }
    const key = this.loadingDraftKey;
    this.loadingDraftKey = '';
    this.drafts.saveAttachments(key, this.attachments());
    // Preserve early edits after storage loads, including in a replacement composer.
    void this.recovery.recover(key, this.draft(), []);
  }

  private async restoreDraft(key: string, text: string, attachments: MobileAttachmentDto[]): Promise<void> {
    await this.recovery.recover(key, text, attachments);
  }

  protected async recoverLegacyDraft(): Promise<void> {
    const current = this.operationScope();
    await this.recovery.recoverLegacy(this.contextKey(), `instance:${this.instanceId()}`);
    if (current()) this.legacyDraftAvailable.set(false);
  }

  protected back(): void {
    void this.router.navigate([this.returnRoute()]);
  }
}
