import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { connectionHeadline } from '../../core/connection-status';
import { ConversationDraftRecoveryService, joinDraftText } from '../../core/conversation-draft-recovery.service';
import { DraftStore } from '../../core/draft-store';
import { GatewayClient } from '../../core/gateway-client.service';
import { HapticsService } from '../../core/haptics.service';
import { HostStore } from '../../core/host-store';
import { ImageAttachmentService } from '../../core/image-attachment.service';
import type { MobileAttachmentDto, MobileQueuedMessageDto } from '../../core/models';
import { VoiceInputService } from '../../core/voice-input.service';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { ComposerQueueComponent } from './composer-queue.component';

const NOTICE_TIMEOUT_MS = 6000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Component({
  standalone: true,
  selector: 'app-conversation-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ComposerQueueComponent, MobileIconComponent],
  templateUrl: './conversation-composer.component.html',
  styleUrls: ['./conversation-composer.component.scss'],
})
export class ConversationComposerComponent {
  private readonly gateway = inject(GatewayClient);
  private readonly images = inject(ImageAttachmentService);
  private readonly drafts = inject(DraftStore);
  private readonly recovery = inject(ConversationDraftRecoveryService);
  private readonly haptics = inject(HapticsService);
  private readonly voice = inject(VoiceInputService);
  private readonly hosts = inject(HostStore);

  readonly instanceId = input.required<string>();
  readonly activityLabel = input.required<string>();
  readonly working = input(false);
  readonly stopping = input(false);
  readonly status = input('');
  protected readonly canSteer = computed(() =>
    ['busy', 'processing', 'thinking_deeply', 'waiting_for_permission'].includes(this.status()));

  protected readonly draft = signal('');
  protected readonly legacyDraftAvailable = signal(false);
  protected readonly attachments = signal<MobileAttachmentDto[]>([]);
  protected readonly attachBusy = signal(false);
  protected readonly canAttach = this.images.available;
  protected readonly canDictate = this.voice.available;
  protected readonly listening = this.voice.listening;
  protected readonly sending = signal(false);
  protected readonly interrupting = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly noticeIsError = signal(false);
  protected readonly queuePending = signal<string | null>(null);
  protected readonly online = this.gateway.online;
  protected readonly headline = computed(() => connectionHeadline(this.gateway.state()));
  protected readonly hostName = computed(() => this.hosts.activeHost()?.name ?? 'Host');
  protected readonly queued = computed(() => this.gateway.dataHostId() === this.hosts.activeHost()?.id
    ? this.gateway.snapshot()?.instances.find((instance) => instance.id === this.instanceId())?.queuedMessages ?? []
    : []);

  private readonly draftKeyId = signal('');
  private readonly contextKey = computed(() => JSON.stringify([
    'instance', this.hosts.activeHost()?.id ?? '', this.instanceId(),
  ]));
  private readonly draftEl = viewChild<ElementRef<HTMLTextAreaElement>>('draftEl');
  private loadingDraftKey = '';
  private draftGeneration = 0;
  private detachDraft: (() => void) | undefined;
  private destroyed = false;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.persistDraftOnExit();
      this.detachDraft?.();
      this.destroyed = true;
      this.draftGeneration += 1;
      clearTimeout(this.noticeTimer);
      void this.voice.stop();
    });

    effect(() => {
      if (this.voice.listening()) this.draft.set(this.voice.text());
    });

    effect(() => {
      const key = this.contextKey();
      untracked(() => this.startDraftSession(key));
    });

    effect(() => this.persistDraft());

    afterRenderEffect(() => {
      this.draft();
      const element = this.draftEl()?.nativeElement;
      if (!element) return;
      queueMicrotask(() => {
        if (this.destroyed || !element.isConnected) return;
        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, Math.max(72, window.innerHeight * 0.22))}px`;
      });
    });
  }

  async interrupt(escalate = false): Promise<void> {
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
      if (accepted) this.showNotice('Stopping…');
      else {
        this.haptics.error();
        this.showNotice('Nothing to stop — this session is not running a turn.', true);
      }
    } catch (error) {
      if (!current()) return;
      this.haptics.error();
      this.showNotice(`Stop failed: ${errorText(error)}`, true);
    } finally {
      if (current()) this.interrupting.set(false);
    }
  }

  showNotice(text: string, isError = false): void {
    this.notice.set(text);
    this.noticeIsError.set(isError);
    clearTimeout(this.noticeTimer);
    if (!isError) this.noticeTimer = setTimeout(() => this.notice.set(null), NOTICE_TIMEOUT_MS);
  }

  protected clearNotice(): void {
    clearTimeout(this.noticeTimer);
    this.notice.set(null);
  }

  protected onEnter(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (!keyboard.isComposing && keyboard.keyCode !== 229 && (keyboard.metaKey || keyboard.ctrlKey)) {
      event.preventDefault();
      void this.send(event);
    }
  }

  protected canSend(): boolean {
    return this.draft().trim().length > 0 || this.attachments().length > 0;
  }

  protected async pickImages(): Promise<void> {
    await this.attach(async () => this.images.pickImages());
  }

  protected async pasteImageFromClipboard(): Promise<void> {
    await this.attach(async () => {
      const pasted = await this.images.pasteImageFromClipboard();
      if (!pasted) this.showNotice('No image was found. Copy an image first or use Add photo.', true);
      return pasted ? [pasted] : [];
    });
  }

  protected async onPaste(event: ClipboardEvent): Promise<void> {
    await this.attach(() => this.images.attachmentsFromPasteEvent(event));
  }

  protected removeAttachment(attachment: MobileAttachmentDto): void {
    this.attachments.update((current) => current.filter((item) => item !== attachment));
  }

  protected async toggleDictation(): Promise<void> {
    const current = this.operationScope();
    if (this.voice.listening()) {
      const text = this.voice.text();
      const stopped = this.voice.stop();
      this.draft.set(text);
      await stopped;
      if (current()) this.haptics.tap();
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

  protected async send(event: Event, steer = false): Promise<void> {
    event.preventDefault();
    if (!this.canSend() || this.sending() || !this.online()) return;
    if (steer && !this.canSteer()) return;
    const key = this.contextKey();
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
      if (steer) {
        await this.gateway.steerInput(this.instanceId(), text, attachments.length ? attachments : undefined);
      } else {
        const result = await this.gateway.sendInput(
          this.instanceId(), text, attachments.length ? attachments : undefined,
        );
        if (current() && result.queued) this.showNotice('Queued. It will send when this session is free.');
      }
    } catch (error) {
      await this.restoreDraft(key, text, attachments);
      if (current()) {
        this.haptics.error();
        this.showNotice(`${steer ? 'Steer' : 'Send'} not confirmed: ${errorText(error)}`, true);
      }
    } finally {
      if (current()) this.sending.set(false);
    }
  }

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
    } catch (error) {
      if (current()) this.showNotice(`Could not change the queue: ${errorText(error)}`, true);
    } finally {
      if (current()) this.queuePending.set(null);
    }
  }

  protected async recoverLegacyDraft(): Promise<void> {
    const current = this.operationScope();
    await this.recovery.recoverLegacy(this.contextKey(), `instance:${this.instanceId()}`);
    if (current()) this.legacyDraftAvailable.set(false);
  }

  private startDraftSession(key: string): void {
    const generation = ++this.draftGeneration;
    this.detachDraft?.();
    void this.voice.stop();
    this.persistDraftOnExit();
    this.loadingDraftKey = key;
    this.draftKeyId.set('');
    this.draft.set('');
    this.attachments.set(this.drafts.attachments(key));
    this.attachBusy.set(false);
    this.legacyDraftAvailable.set(false);
    this.sending.set(false);
    this.interrupting.set(false);
    this.queuePending.set(null);
    this.clearNotice();
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
  }

  private async attach(pick: () => Promise<MobileAttachmentDto[]>): Promise<void> {
    if (this.attachBusy()) return;
    const key = this.contextKey();
    const current = this.operationScope();
    this.attachBusy.set(true);
    try {
      const attachments = await pick();
      if (attachments.length) await this.restoreDraft(key, '', attachments);
    } catch (error) {
      if (current()) this.showNotice(errorText(error), true);
    } finally {
      if (current()) this.attachBusy.set(false);
    }
  }

  private operationScope(): () => boolean {
    const key = this.contextKey();
    const generation = this.draftGeneration;
    return () => !this.destroyed && key === this.contextKey() && generation === this.draftGeneration;
  }

  private persistDraft(): void {
    const key = this.draftKeyId();
    if (!key) return;
    this.drafts.save(key, this.draft());
    this.drafts.saveAttachments(key, this.attachments());
  }

  private persistDraftOnExit(): void {
    if (!this.loadingDraftKey) { this.persistDraft(); return; }
    const key = this.loadingDraftKey;
    this.loadingDraftKey = '';
    this.drafts.saveAttachments(key, this.attachments());
    void this.recovery.recover(key, this.draft(), []);
  }

  private async restoreDraft(key: string, text: string, attachments: MobileAttachmentDto[]): Promise<void> {
    await this.recovery.recover(key, text, attachments);
  }
}
