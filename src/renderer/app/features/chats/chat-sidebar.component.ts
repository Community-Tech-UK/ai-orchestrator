import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ChatProvider, ChatRecord } from '../../../../shared/types/chat.types';
import { ChatStore } from '../../core/state/chat.store';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { deriveChatRuntimeState, type ChatRuntimeState } from './chat-runtime-state';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import type { PendingSelection } from '../models/compact-model-picker.types';

const DEFAULT_PENDING_SELECTION: PendingSelection = {
  provider: 'claude',
  model: null,
  reasoning: null,
};

@Component({
  selector: 'app-chat-sidebar',
  standalone: true,
  imports: [FormsModule, CompactModelPickerComponent],
  templateUrl: './chat-sidebar.component.html',
  styleUrl: './chat-sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatSidebarComponent implements OnInit {
  readonly chatStore = inject(ChatStore);
  private readonly instanceStore = inject(InstanceStore);
  private readonly historyStore = inject(HistoryStore);
  private readonly settingsStore = inject(SettingsStore);
  private readonly fileIpc = inject(FileIpcService);

  showCreate = signal(false);
  name = signal('');
  /**
   * Form-level provider/model/reasoning state. Replaces the old separate
   * `provider`/`model` signals; the compact picker reads/writes through
   * `[(formSelection)]`.
   */
  formSelection = signal<PendingSelection>({ ...DEFAULT_PENDING_SELECTION });
  cwd = signal('');

  readonly canCreate = computed(() => this.cwd().trim().length > 0 && !this.chatStore.loading());

  ngOnInit(): void {
    void this.chatStore.initialize();
  }

  openCreate(): void {
    const latestCwd = this.chatStore.chats().find((chat) => !!chat.currentCwd)?.currentCwd;
    this.cwd.set(latestCwd || this.settingsStore.settings().defaultWorkingDirectory || '');
    this.name.set('');
    this.formSelection.set({ ...DEFAULT_PENDING_SELECTION });
    this.showCreate.set(true);
  }

  async browseCwd(): Promise<void> {
    const folder = await this.fileIpc.selectFolder();
    if (folder) {
      this.cwd.set(folder);
    }
  }

  async createChat(): Promise<void> {
    if (!this.canCreate()) {
      return;
    }
    this.clearWorkspaceSelection();
    const sel = this.formSelection();
    await this.chatStore.create({
      name: this.name().trim() || undefined,
      provider: sel.provider,
      model: sel.model ?? null,
      reasoningEffort: sel.reasoning,
      currentCwd: this.cwd().trim(),
    });
    if (!this.chatStore.error()) {
      this.showCreate.set(false);
    }
  }

  selectChat(chatId: string): void {
    this.clearWorkspaceSelection();
    void this.chatStore.select(chatId);
  }

  archiveChat(event: MouseEvent, chatId: string): void {
    event.stopPropagation();
    void this.chatStore.archive(chatId);
  }

  cwdLabel(cwd: string | null): string {
    if (!cwd) return 'no project';
    const trimmed = cwd.replace(/\/+$/, '');
    return trimmed.split('/').pop() || cwd;
  }

  providerLabel(provider: ChatProvider | null, model: string | null): string {
    if (!provider) return 'setup required';
    return model ? `${provider} · ${model}` : provider;
  }

  runtimeState(chat: ChatRecord): ChatRuntimeState {
    const instance = chat.currentInstanceId
      ? this.instanceStore.getInstance(chat.currentInstanceId)
      : null;
    return deriveChatRuntimeState(chat, instance?.status);
  }

  private clearWorkspaceSelection(): void {
    this.historyStore.clearSelection();
    this.instanceStore.setSelectedInstance(null);
  }
}
