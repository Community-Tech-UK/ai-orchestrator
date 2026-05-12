import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ChatProvider } from '../../../../shared/types/chat.types';
import type { ConversationMessageRecord } from '../../../../shared/types/conversation-ledger.types';
import type { FileAttachment, InstanceStatus, OutputMessage, ThinkingContent } from '../../../../shared/types/instance.types';
import type { OperatorRunGraph, OperatorRunRecord } from '../../../../shared/types/operator.types';
import { ChatStore } from '../../core/state/chat.store';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceListStore } from '../../core/state/instance/instance-list.store';
import { SettingsStore } from '../../core/state/settings.store';
import { DraftService } from '../../core/services/draft.service';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { OperatorIpcService } from '../../core/services/ipc/operator-ipc.service';
import { OutputStreamComponent } from '../instance-detail/output-stream.component';
import { InputPanelComponent } from '../instance-detail/input-panel.component';
import { ActivityStatusComponent } from '../instance-detail/activity-status.component';
import { FileAttachmentService } from '../instance-detail/file-attachment.service';
import { DropZoneComponent } from '../file-drop/drop-zone.component';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import { LoopControlComponent } from '../loop/loop-control.component';
import { SessionArtifactsStripComponent } from './session-artifacts-strip.component';
import { LoopStore } from '../../core/state/loop.store';
import { LoopPromptHistoryService } from '../loop/loop-prompt-history.service';
import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';

@Component({
  selector: 'app-chat-detail',
  standalone: true,
  imports: [
    FormsModule,
    DropZoneComponent,
    OutputStreamComponent,
    InputPanelComponent,
    ActivityStatusComponent,
    CompactModelPickerComponent,
    LoopControlComponent,
    SessionArtifactsStripComponent,
  ],
  templateUrl: './chat-detail.component.html',
  styleUrl: './chat-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatDetailComponent {
  readonly chatStore = inject(ChatStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly instanceStore = inject(InstanceStore);
  private readonly instanceListStore = inject(InstanceListStore);
  private readonly settingsStore = inject(SettingsStore);
  private readonly draftService = inject(DraftService);
  private readonly fileAttachment = inject(FileAttachmentService);
  private readonly fileIpc = inject(FileIpcService);
  private readonly operatorIpc = inject(OperatorIpcService);
  private readonly loopStore = inject(LoopStore);
  private readonly loopPromptHistory = inject(LoopPromptHistoryService);

  readonly draftName = signal('');
  readonly draftCwd = signal('');
  readonly runs = signal<OperatorRunRecord[]>([]);
  readonly activeRunGraph = signal<OperatorRunGraph | null>(null);
  readonly runLoading = signal(false);
  private runLoadSequence = 0;
  private loadedRunThreadId: string | null = null;
  private readonly unsubscribeOperatorEvents: () => void;

  readonly detail = this.chatStore.selectedDetail;
  readonly chat = computed(() => this.detail()?.chat ?? null);
  readonly currentInstance = computed(() => {
    const detail = this.detail();
    const instanceId = detail?.chat.currentInstanceId;
    if (!instanceId) {
      return detail?.currentInstance ?? null;
    }
    return this.instanceStore.getInstance(instanceId) ?? detail?.currentInstance ?? null;
  });
  readonly messages = computed<OutputMessage[]>(() => {
    const detail = this.detail();
    if (!detail) {
      return [];
    }

    const ledgerMessages = detail.conversation.messages.map((message) =>
      this.toOutputMessage(message)
    );
    const seenIds = new Set(ledgerMessages.map((message) => message.id));
    const runtimeMessages = this.currentInstance()?.outputBuffer ?? [];
    const runtimeOnly = runtimeMessages.filter((message) =>
      message.type !== 'user' && !seenIds.has(message.id)
    );

    return [...ledgerMessages, ...runtimeOnly];
  });
  readonly hasMessages = computed(() => this.detail()?.conversation.messages.length ? true : false);
  readonly setupComplete = computed(() => {
    const chat = this.chat();
    return !!chat?.provider && !!chat.currentCwd;
  });
  readonly streamInstanceId = computed(() =>
    this.currentInstance()?.id ?? this.chat()?.id ?? 'chat'
  );
  readonly providerForUi = computed<ChatProvider>(() =>
    this.chat()?.provider ?? 'claude'
  );
  readonly modelForUi = computed(() =>
    this.chat()?.model ?? undefined
  );
  readonly statusForUi = computed<InstanceStatus>(() =>
    this.currentInstance()?.status ?? 'idle'
  );
  readonly isBusy = computed(() => {
    const status = this.statusForUi();
    return status === 'busy'
      || status === 'processing'
      || status === 'thinking_deeply'
      || status === 'waiting_for_permission';
  });
  readonly isRespawning = computed(() => {
    const status = this.statusForUi();
    return status === 'respawning'
      || status === 'interrupting'
      || status === 'cancelling'
      || status === 'interrupt-escalating';
  });
  readonly activity = computed(() => {
    const instance = this.currentInstance();
    return instance ? this.instanceStore.instanceActivities().get(instance.id) ?? '' : '';
  });
  readonly busySince = computed(() => {
    const instance = this.currentInstance();
    if (!instance) {
      return undefined;
    }
    return instance.status === 'busy' ? Date.now() : undefined;
  });

  readonly showThinking = this.settingsStore.showThinking;
  readonly thinkingDefaultExpanded = this.settingsStore.thinkingDefaultExpanded;
  readonly showToolMessages = this.settingsStore.showToolMessages;

  /**
   * DraftService key for this chat's pending files/folders.
   * Returns null until a chat is selected so handlers no-op safely.
   *
   * Keyed by `chat.id` (not the runtime instance id) so attachments persist
   * across the chat's lifecycle — including when there's no instance yet
   * (brand-new chat) or the runtime instance is torn down and recreated.
   */
  private readonly chatDraftKey = computed(() => {
    const id = this.chat()?.id;
    return id ? `chat:${id}` : null;
  });

  readonly pendingFiles = computed<File[]>(() => {
    // Subscribe to DraftService attachment changes so this computed
    // re-evaluates whenever files are added/removed.
    this.draftService.attachmentVersion();
    const key = this.chatDraftKey();
    return key ? this.draftService.getPendingFiles(key) : [];
  });

  readonly pendingFolders = computed<string[]>(() => {
    this.draftService.attachmentVersion();
    const key = this.chatDraftKey();
    return key ? this.draftService.getPendingFolders(key) : [];
  });

  private readonly syncDrafts = effect(() => {
    const chat = this.chat();
    if (!chat) {
      return;
    }

    this.draftName.set(chat.name);
    this.draftCwd.set(chat.currentCwd ?? '');
  });

  private readonly syncRuns = effect(() => {
    const threadId = this.chat()?.ledgerThreadId ?? null;
    if (threadId === this.loadedRunThreadId) {
      return;
    }
    this.loadedRunThreadId = threadId;
    queueMicrotask(() => void this.loadRunsForThread(threadId));
  });

  constructor() {
    this.unsubscribeOperatorEvents = this.operatorIpc.onOperatorEvent(() => {
      const threadId = this.chat()?.ledgerThreadId ?? null;
      if (threadId) {
        void this.loadRunsForThread(threadId);
      }
    });
    this.destroyRef.onDestroy(() => this.unsubscribeOperatorEvents());
  }

  async saveName(): Promise<void> {
    const chat = this.chat();
    const name = this.draftName().trim();
    if (!chat || !name || name === chat.name) {
      return;
    }
    await this.chatStore.rename(chat.id, name);
  }

  async browseCwd(): Promise<void> {
    const folder = await this.fileIpc.selectFolder();
    if (!folder) {
      return;
    }
    this.draftCwd.set(folder);
    await this.applyCwd();
  }

  async applyCwd(): Promise<void> {
    const chat = this.chat();
    const cwd = this.draftCwd().trim();
    if (!chat || !cwd || cwd === chat.currentCwd) {
      return;
    }
    await this.chatStore.setCwd(chat.id, cwd);
  }

  async toggleYolo(event: Event): Promise<void> {
    const chat = this.chat();
    if (!chat) {
      return;
    }
    const enabled = (event.target as HTMLInputElement).checked;
    await this.chatStore.setYolo(chat.id, enabled);
  }

  async onSendMessage(message: string): Promise<void> {
    await this.sendChatMessage(message);
  }

  async onSteerMessage(message: string): Promise<void> {
    // Chat-detail currently has no separate steer path — same behavior as send.
    await this.sendChatMessage(message);
  }

  /**
   * Send the composed message through the chat store with any pending
   * attachments/folders, then clear the per-chat draft state on success.
   *
   * Folder paths are inlined as `[Folder: …]` references at the top of the
   * message (matches the instance-detail behavior) because chats don't have
   * a separate "folder pin" wire format — folders are advisory references,
   * not file uploads.
   *
   * Files are converted through the same `InstanceListStore.fileToAttachments`
   * pipeline used by instance-detail so size/dimension limits, tiling, and
   * compression are consistent across surfaces.
   */
  private async sendChatMessage(message: string): Promise<void> {
    const key = this.chatDraftKey();
    const folders = key ? this.draftService.getPendingFolders(key) : [];
    const files = key ? this.draftService.getPendingFiles(key) : [];
    const finalMessage = this.fileAttachment.prependPendingFolders(message, folders);

    let attachments: FileAttachment[] | undefined;
    if (files.length > 0) {
      try {
        attachments = (
          await Promise.all(files.map((file) => this.instanceListStore.fileToAttachments(file)))
        ).flat();
      } catch (error) {
        this.chatStore.setError(
          error instanceof Error ? error.message : 'Failed to attach files',
        );
        return;
      }
    }

    const errorBefore = this.chatStore.error();
    await this.chatStore.sendMessage(finalMessage, attachments);
    // Only clear pending state if the send actually succeeded. The store
    // surfaces failures via `error()`; if a new error appeared, keep the
    // user's attachments so they can retry without re-dropping every file.
    const errorAfter = this.chatStore.error();
    if (key && errorAfter === errorBefore) {
      this.draftService.clearPendingFiles(key);
      this.draftService.clearPendingFolders(key);
    }
  }

  // ===== File drop / paste handlers (wired to <app-drop-zone>) =====

  onFilesDropped(files: File[]): void {
    const key = this.chatDraftKey();
    if (!key || files.length === 0) return;
    this.draftService.addPendingFiles(key, files);
  }

  onImagesPasted(images: File[]): void {
    this.onFilesDropped(images);
  }

  onFolderDropped(folderPath: string): void {
    const key = this.chatDraftKey();
    if (!key || !folderPath) return;
    this.draftService.addPendingFolder(key, folderPath);
  }

  /**
   * Single external path drop (e.g. drag one file out of VSCode).
   * VSCode/Finder/browsers don't include the raw bytes — they hand us a
   * path/URI. `FileAttachmentService.loadDroppedFilesFromPaths` reads the
   * bytes through IPC (CSP blocks `fetch('file://...')`) and rejects dirs.
   */
  async onFilePathDropped(filePath: string): Promise<void> {
    const key = this.chatDraftKey();
    if (!key) return;
    const loaded = await this.fileAttachment.loadDroppedFilesFromPaths([filePath]);
    if (loaded.length > 0) {
      this.draftService.addPendingFiles(key, loaded);
    }
  }

  async onFilePathsDropped(filePaths: string[]): Promise<void> {
    const key = this.chatDraftKey();
    if (!key || filePaths.length === 0) return;
    const loaded = await this.fileAttachment.loadDroppedFilesFromPaths(filePaths);
    if (loaded.length > 0) {
      this.draftService.addPendingFiles(key, loaded);
    }
  }

  onRemoveFile(file: File): void {
    const key = this.chatDraftKey();
    if (!key) return;
    this.draftService.removePendingFile(key, file);
  }

  onRemoveFolder(folder: string): void {
    const key = this.chatDraftKey();
    if (!key) return;
    this.draftService.removePendingFolder(key, folder);
  }

  async onAddFiles(): Promise<void> {
    const key = this.chatDraftKey();
    if (!key) return;
    const cwd = this.chat()?.currentCwd ?? null;
    const loaded = await this.fileAttachment.selectAndLoadFiles(cwd);
    if (loaded.length > 0) {
      this.draftService.addPendingFiles(key, loaded);
    }
  }

  async refreshRuns(): Promise<void> {
    await this.loadRunsForThread(this.chat()?.ledgerThreadId ?? null);
  }

  async cancelRun(runId: string): Promise<void> {
    const response = await this.operatorIpc.cancelRun(runId);
    if (response.success && response.data) {
      this.activeRunGraph.set(response.data);
      await this.refreshRuns();
    }
  }

  isActiveRun(run: OperatorRunRecord): boolean {
    return run.status === 'queued' || run.status === 'running' || run.status === 'waiting';
  }

  cwdLabel(cwd: string | null): string {
    if (!cwd) {
      return 'No project selected';
    }
    const trimmed = cwd.replace(/\/+$/, '');
    return trimmed.split('/').pop() || cwd;
  }

  private toOutputMessage(message: ConversationMessageRecord): OutputMessage {
    const rawJson = this.asRecord(message.rawJson);
    const rawMetadata = this.asRecord(rawJson?.['metadata']);
    const type = this.toOutputMessageType(message, rawMetadata);
    const metadata = {
      ...(rawMetadata ?? {}),
      ledgerMessageId: message.id,
      ledgerSequence: message.sequence,
      nativeTurnId: message.nativeTurnId,
      phase: message.phase,
    };
    return {
      id: message.nativeMessageId ?? message.id,
      timestamp: message.createdAt,
      type,
      content: message.content,
      metadata,
      attachments: this.asAttachments(rawJson?.['attachments']),
      thinking: this.asThinking(rawJson?.['thinking']),
      thinkingExtracted: typeof rawJson?.['thinkingExtracted'] === 'boolean'
        ? rawJson['thinkingExtracted']
        : undefined,
    };
  }

  private toOutputMessageType(
    message: ConversationMessageRecord,
    metadata: Record<string, unknown> | null,
  ): OutputMessage['type'] {
    if (message.role === 'user') {
      return 'user';
    }
    if (message.role === 'system' || message.role === 'event') {
      return 'system';
    }
    if (message.phase === 'error' || metadata?.['kind'] === 'error') {
      return 'error';
    }
    if (message.role === 'tool') {
      return message.phase === 'tool_result' || metadata?.['kind'] === 'tool_result'
        ? 'tool_result'
        : 'tool_use';
    }
    return 'assistant';
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private asAttachments(value: unknown): FileAttachment[] | undefined {
    return Array.isArray(value) ? value as FileAttachment[] : undefined;
  }

  private asThinking(value: unknown): ThinkingContent[] | undefined {
    return Array.isArray(value) ? value as ThinkingContent[] : undefined;
  }

  async onLoopStartRequested(payload: {
    config: LoopStartConfigInput;
    firstMessage: string;
    attachments: { name: string; data: Uint8Array }[];
    onResolved: (ok: boolean, error?: string) => void;
  }): Promise<void> {
    try {
      const chatId = this.detail()?.chat.id;
      if (!chatId) {
        payload.onResolved(false, 'No chat selected.');
        return;
      }
      const r = await this.loopStore.start(chatId, payload.config, payload.attachments);
      if (r.ok) {
        // Remember the loop directive (what's reusable next time), not the
        // textarea goal which is task-specific.
        this.loopPromptHistory.remember(payload.config.iterationPrompt ?? payload.config.initialPrompt);
        payload.onResolved(true);
      } else {
        const msg = r.error ?? 'unknown error';
        this.chatStore.setError(`Loop start failed: ${msg}`);
        payload.onResolved(false, msg);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.chatStore.setError(`Loop start failed: ${msg}`);
      payload.onResolved(false, msg);
    }
  }

  async onLoopStopRequested(): Promise<void> {
    const chatId = this.detail()?.chat.id;
    if (!chatId) return;
    const a = this.loopStore.activeForChat(chatId)();
    if (a) await this.loopStore.cancel(a.id);
  }

  private async loadRunsForThread(threadId: string | null): Promise<void> {
    const sequence = ++this.runLoadSequence;
    if (!threadId) {
      this.runs.set([]);
      this.activeRunGraph.set(null);
      return;
    }

    this.runLoading.set(true);
    try {
      const response = await this.operatorIpc.listRuns({ threadId, limit: 5 });
      if (sequence !== this.runLoadSequence) {
        return;
      }
      if (!response.success || !response.data) {
        this.runs.set([]);
        this.activeRunGraph.set(null);
        return;
      }
      this.runs.set(response.data);
      const activeRun = response.data[0] ?? null;
      if (!activeRun) {
        this.activeRunGraph.set(null);
        return;
      }
      const graphResponse = await this.operatorIpc.getRun(activeRun.id);
      if (sequence === this.runLoadSequence && graphResponse.success) {
        this.activeRunGraph.set(graphResponse.data ?? null);
      }
    } finally {
      if (sequence === this.runLoadSequence) {
        this.runLoading.set(false);
      }
    }
  }
}
