import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ChatProvider } from '../../../../shared/types/chat.types';
import type { ConversationMessageRecord } from '../../../../shared/types/conversation-ledger.types';
import type { FileAttachment, InstanceStatus, OutputMessage, ThinkingContent } from '../../../../shared/types/instance.types';
import type { OperatorRunGraph, OperatorRunRecord } from '../../../../shared/types/operator.types';
import { ChatStore } from '../../core/state/chat.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { OperatorIpcService } from '../../core/services/ipc/operator-ipc.service';
import { OutputStreamComponent } from '../instance-detail/output-stream.component';
import { InputPanelComponent } from '../instance-detail/input-panel.component';
import { ActivityStatusComponent } from '../instance-detail/activity-status.component';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import { LoopControlComponent } from '../loop/loop-control.component';
import { LoopStore } from '../../core/state/loop.store';
import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';

@Component({
  selector: 'app-chat-detail',
  standalone: true,
  imports: [
    FormsModule,
    OutputStreamComponent,
    InputPanelComponent,
    ActivityStatusComponent,
    CompactModelPickerComponent,
    LoopControlComponent,
  ],
  templateUrl: './chat-detail.component.html',
  styleUrl: './chat-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatDetailComponent {
  readonly chatStore = inject(ChatStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly instanceStore = inject(InstanceStore);
  private readonly settingsStore = inject(SettingsStore);
  private readonly fileIpc = inject(FileIpcService);
  private readonly operatorIpc = inject(OperatorIpcService);
  private readonly loopStore = inject(LoopStore);

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
    await this.chatStore.sendMessage(message);
  }

  async onSteerMessage(message: string): Promise<void> {
    await this.chatStore.sendMessage(message);
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

  async onLoopStartRequested(config: LoopStartConfigInput): Promise<void> {
    const chatId = this.detail()?.chat.id;
    if (!chatId) return;
    const r = await this.loopStore.start(chatId, config);
    if (!r.ok) console.error('Loop start failed:', r.error);
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
