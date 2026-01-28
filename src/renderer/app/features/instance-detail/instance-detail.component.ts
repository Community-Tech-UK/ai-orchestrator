/**
 * Instance Detail Component - Full view of a selected instance
 */

import {
  Component,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
  HostListener,
  effect
} from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ElectronIpcService } from '../../core/services/ipc';
import { DraftService } from '../../core/services/draft.service';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { OutputStreamComponent } from './output-stream.component';
import { ContextBarComponent } from './context-bar.component';
import { InputPanelComponent } from './input-panel.component';
import { DropZoneComponent } from '../file-drop/drop-zone.component';
import { ActivityStatusComponent } from './activity-status.component';
import { ChildInstancesPanelComponent } from './child-instances-panel.component';
import { TodoListComponent } from './todo-list.component';
import { UserActionRequestComponent } from './user-action-request.component';
import { InstanceHeaderComponent } from './instance-header.component';
import { InstanceWelcomeComponent } from './instance-welcome.component';

@Component({
  selector: 'app-instance-detail',
  standalone: true,
  imports: [
    OutputStreamComponent,
    ContextBarComponent,
    InputPanelComponent,
    DropZoneComponent,
    ActivityStatusComponent,
    ChildInstancesPanelComponent,
    TodoListComponent,
    UserActionRequestComponent,
    InstanceHeaderComponent,
    InstanceWelcomeComponent
  ],
  template: `
    @if (instance(); as inst) {
      <app-drop-zone
        class="full-drop-zone"
        (filesDropped)="onFilesDropped($event)"
        (imagesPasted)="onImagesPasted($event)"
        (filePathDropped)="onFilePathDropped($event)"
        (folderDropped)="onFolderDropped($event)"
      >
        <div class="instance-detail">
          <!-- Header -->
          <app-instance-header
            [instance]="inst"
            [isEditingName]="isEditingName()"
            [isChangingMode]="isChangingMode()"
            [isTogglingYolo]="isTogglingYolo()"
            [showModelDropdown]="showModelDropdown()"
            [selectedCopilotModel]="selectedCopilotModel()"
            [copilotModels]="copilotModels()"
            (startEditName)="onStartEditName()"
            (cancelEditName)="onCancelEditName()"
            (saveName)="onSaveName($event)"
            (cycleAgentMode)="onCycleAgentMode()"
            (toggleYolo)="onToggleYolo()"
            (selectFolder)="onSelectFolder()"
            (interrupt)="onInterrupt()"
            (restart)="onRestart()"
            (terminate)="onTerminate()"
            (createChild)="onCreateChild()"
            (toggleModelDropdown)="toggleModelDropdown()"
            (closeModelDropdown)="showModelDropdown.set(false)"
            (selectCopilotModel)="onSelectCopilotModel($event)"
          />

          <!-- Context bar -->
          <div class="context-section">
            <app-context-bar [usage]="inst.contextUsage" [showDetails]="true" />
          </div>

          <!-- TODO list -->
          <app-todo-list [sessionId]="inst.sessionId" />

          <!-- Output stream -->
          <div class="output-section">
            <app-output-stream
              [messages]="inst.outputBuffer"
              [instanceId]="inst.id"
              [provider]="inst.provider"
              [showThinking]="showThinking()"
              [thinkingDefaultExpanded]="thinkingDefaultExpanded()"
            />
            @if (inst.status === 'busy' || inst.status === 'initializing') {
              <app-activity-status
                [status]="inst.status"
                [activity]="currentActivity()"
              />
            }
          </div>

          <!-- User action requests -->
          <app-user-action-request [instanceId]="inst.id" />

          <!-- Input panel -->
          <app-input-panel
            [instanceId]="inst.id"
            [disabled]="inst.status === 'terminated'"
            [placeholder]="inputPlaceholder()"
            [pendingFiles]="pendingFiles()"
            [pendingFolders]="pendingFolders()"
            [queuedCount]="queuedMessageCount()"
            [queuedMessages]="queuedMessages()"
            [isBusy]="inst.status === 'busy'"
            (sendMessage)="onSendMessage($event)"
            (removeFile)="onRemoveFile($event)"
            (removeFolder)="onRemoveFolder($event)"
            (addFiles)="onAddFiles()"
            (cancelQueuedMessage)="onCancelQueuedMessage($event)"
          />

          <!-- Children section -->
          <app-child-instances-panel
            [childrenIds]="inst.childrenIds"
            (selectChild)="onSelectChild($event)"
          />
        </div>
      </app-drop-zone>
    } @else if (isCreatingInstance()) {
      <div class="creating-view">
        <div class="creating-content">
          <div class="creating-spinner"></div>
          <p class="creating-text">Starting conversation...</p>
        </div>
      </div>
    } @else {
      <app-instance-welcome
        [workingDirectory]="welcomeWorkingDirectory()"
        [pendingFiles]="welcomePendingFiles()"
        (selectFolder)="onSelectWelcomeFolder()"
        (sendMessage)="onWelcomeSendMessage($event)"
        (filesDropped)="onWelcomeFilesDropped($event)"
        (imagesPasted)="onWelcomeImagesPasted($event)"
        (removeFile)="onWelcomeRemoveFile($event)"
        (addFiles)="onWelcomeAddFiles()"
      />
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex: 1;
        min-width: 0;
        min-height: 0;
      }

      .full-drop-zone {
        display: flex;
        flex: 1;
        min-width: 0;
        min-height: 0;
      }

      .instance-detail {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
        padding: var(--spacing-lg);
        gap: var(--spacing-md);
        position: relative;
        z-index: 1;
      }

      .context-section {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--bg-secondary);
        border-radius: var(--radius-md);
        border: 1px solid var(--border-subtle);
      }

      .output-section {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        background: var(--bg-secondary);
        border-radius: var(--radius-lg);
        border: 1px solid var(--border-subtle);
        overflow: hidden;
      }

      .output-section app-output-stream {
        flex: 1;
        min-height: 0;
      }

      .output-section app-activity-status {
        flex-shrink: 0;
        padding: 0 var(--spacing-md);
        padding-bottom: var(--spacing-sm);
      }

      .creating-view {
        display: flex;
        flex: 1;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        background: var(--bg-primary);
        position: relative;
      }

      .creating-view::before {
        content: '';
        position: absolute;
        inset: 0;
        background: radial-gradient(
          ellipse 60% 40% at 50% 40%,
          rgba(var(--primary-rgb), 0.1),
          transparent
        );
        pointer-events: none;
      }

      .creating-content {
        text-align: center;
        position: relative;
        z-index: 1;
      }

      .creating-spinner {
        width: 48px;
        height: 48px;
        border: 2px solid var(--border-subtle);
        border-top-color: var(--primary-color);
        border-radius: 50%;
        margin: 0 auto var(--spacing-lg);
        animation: spin 0.8s linear infinite;
        box-shadow: 0 0 24px rgba(var(--primary-rgb), 0.3);
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .creating-text {
        font-family: var(--font-mono);
        font-size: 13px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--text-muted);
        margin: 0;
        animation: pulse 2s ease-in-out infinite;
      }

      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.5;
        }
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstanceDetailComponent {
  private store = inject(InstanceStore);
  private settingsStore = inject(SettingsStore);
  private ipc = inject(ElectronIpcService);
  private draftService = inject(DraftService);
  private providerState = inject(ProviderStateService);

  instance = this.store.selectedInstance;
  currentActivity = this.store.selectedInstanceActivity;

  // Settings for thinking display
  showThinking = this.settingsStore.showThinking;
  thinkingDefaultExpanded = this.settingsStore.thinkingDefaultExpanded;
  welcomePendingFiles = signal<File[]>([]);
  welcomeWorkingDirectory = signal<string | null>(null);
  isEditingName = signal(false);
  isCreatingInstance = signal(false);
  isChangingMode = signal(false);
  isTogglingYolo = signal(false);
  showModelDropdown = signal(false);
  selectedCopilotModel = signal<string>('claude-sonnet-4-5');
  copilotModels = signal<{ id: string; name: string }[]>([
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
    { id: 'o3', name: 'OpenAI o3' },
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' }
  ]);

  pendingFiles = computed(() => {
    const inst = this.instance();
    if (!inst) return [];
    this.draftService.version();
    return this.draftService.getPendingFiles(inst.id);
  });

  pendingFolders = computed(() => {
    const inst = this.instance();
    if (!inst) return [];
    this.draftService.version();
    return this.draftService.getPendingFolders(inst.id);
  });

  queuedMessageCount = computed(() => {
    const inst = this.instance();
    if (!inst) return 0;
    return this.store.getQueuedMessageCount(inst.id);
  });

  queuedMessages = computed(() => {
    const inst = this.instance();
    if (!inst) return [];
    return this.store.getMessageQueue(inst.id);
  });

  inputPlaceholder = computed(() => {
    const inst = this.instance();
    if (!inst) return '';

    const providerName = this.getProviderDisplayName(inst.provider);
    switch (inst.status) {
      case 'waiting_for_input':
        return `${providerName} is waiting for your response...`;
      case 'busy':
        return 'Processing...';
      case 'terminated':
        return 'Instance terminated';
      default:
        return `Send a message to ${providerName}...`;
    }
  });

  constructor() {
    effect(() => {
      const defaultDir = this.settingsStore.defaultWorkingDirectory();
      if (!this.welcomeWorkingDirectory()) {
        this.welcomeWorkingDirectory.set(defaultDir || null);
      }
    });

    effect(() => {
      const inst = this.instance();
      if (inst) {
        this.isCreatingInstance.set(false);
      }
    });
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardShortcut(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      const inst = this.instance();
      if (inst && inst.status === 'busy') {
        event.preventDefault();
        this.onInterrupt();
      }
    }
  }

  getProviderDisplayName(provider: string): string {
    switch (provider) {
      case 'claude':
        return 'Claude';
      case 'codex':
        return 'Codex';
      case 'gemini':
        return 'Gemini';
      case 'ollama':
        return 'Ollama';
      case 'copilot':
        return 'Copilot';
      default:
        return 'AI';
    }
  }

  toggleModelDropdown(): void {
    this.showModelDropdown.update((v) => !v);
  }

  onSelectCopilotModel(modelId: string): void {
    this.selectedCopilotModel.set(modelId);
    this.showModelDropdown.set(false);
    console.log(`[InstanceDetail] Selected Copilot model: ${modelId}`);
  }

  onSendMessage(message: string): void {
    const inst = this.instance();
    if (!inst) return;

    const folders = this.pendingFolders();
    let finalMessage = message;
    if (folders.length > 0) {
      const folderRefs = folders.map((f) => `[Folder: ${f}]`).join('\n');
      finalMessage =
        folders.length > 0 && message ? `${folderRefs}\n\n${message}` : folderRefs;
    }

    this.store.sendInput(inst.id, finalMessage, this.pendingFiles());
    this.draftService.clearPendingFiles(inst.id);
    this.draftService.clearPendingFolders(inst.id);
  }

  onCancelQueuedMessage(index: number): void {
    const inst = this.instance();
    if (!inst) return;

    const removedMessage = this.store.removeFromQueue(inst.id, index);
    if (removedMessage) {
      this.draftService.setDraft(inst.id, removedMessage.message);
      if (removedMessage.files && removedMessage.files.length > 0) {
        this.draftService.addPendingFiles(inst.id, removedMessage.files);
      }
    }
  }

  onFilesDropped(files: File[]): void {
    const inst = this.instance();
    if (!inst) return;
    this.draftService.addPendingFiles(inst.id, files);
  }

  onImagesPasted(images: File[]): void {
    const inst = this.instance();
    if (!inst) return;
    this.draftService.addPendingFiles(inst.id, images);
  }

  onFolderDropped(folderPath: string): void {
    const inst = this.instance();
    if (!inst) return;
    this.draftService.addPendingFolder(inst.id, folderPath);
  }

  async onFilePathDropped(filePath: string): Promise<void> {
    const inst = this.instance();
    if (!inst) return;

    if (!window.electronAPI) return;

    try {
      const stats = await window.electronAPI.getFileStats(filePath);
      if (!stats.success || !stats.data) return;
      const data = stats.data as { isDirectory?: boolean };

      if (data.isDirectory) {
        console.log('Directory dropped - not supported yet:', filePath);
        return;
      }

      const response = await fetch(`file://${filePath}`);
      const blob = await response.blob();

      const fileName = filePath.split('/').pop() || 'file';
      const file = new File([blob], fileName, {
        type: blob.type || 'application/octet-stream'
      });

      this.draftService.addPendingFiles(inst.id, [file]);
    } catch (error) {
      console.error('Failed to load file from path:', error);
    }
  }

  onRemoveFile(file: File): void {
    const inst = this.instance();
    if (!inst) return;
    this.draftService.removePendingFile(inst.id, file);
  }

  onRemoveFolder(folder: string): void {
    const inst = this.instance();
    if (!inst) return;
    this.draftService.removePendingFolder(inst.id, folder);
  }

  onRestart(): void {
    const inst = this.instance();
    if (inst) {
      this.store.restartInstance(inst.id);
    }
  }

  onSelectFolder(): void {
    const inst = this.instance();
    if (inst) {
      this.store.selectWorkingDirectory(inst.id);
    }
  }

  onStartEditName(): void {
    this.isEditingName.set(true);
    setTimeout(() => {
      const input = document.querySelector('.name-input') as HTMLInputElement;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  onSaveName(newName: string): void {
    const inst = this.instance();
    if (inst) {
      this.store.renameInstance(inst.id, newName);
    }
    this.isEditingName.set(false);
  }

  onCancelEditName(): void {
    this.isEditingName.set(false);
  }

  async onToggleYolo(): Promise<void> {
    const inst = this.instance();
    if (!inst) return;

    if (inst.status === 'busy') {
      console.log(
        '[InstanceDetail] Cannot toggle YOLO mode while instance is busy'
      );
      return;
    }

    if (!inst.yoloMode) {
      const confirmed = confirm(
        'Enable YOLO mode? This will auto-approve all tool calls for this instance.'
      );
      if (!confirmed) return;
    }

    if (this.isTogglingYolo()) return;

    this.isTogglingYolo.set(true);
    try {
      await this.store.toggleYoloMode(inst.id);
    } finally {
      this.isTogglingYolo.set(false);
    }
  }

  async onCycleAgentMode(): Promise<void> {
    const inst = this.instance();
    if (!inst) return;

    if (inst.status === 'busy') {
      console.log(
        '[InstanceDetail] Cannot change agent mode while instance is busy'
      );
      return;
    }

    if (this.isChangingMode()) return;

    const modes = ['build', 'plan', 'review'];
    const currentIndex = modes.indexOf(inst.agentId || 'build');
    const nextIndex = (currentIndex + 1) % modes.length;

    this.isChangingMode.set(true);
    try {
      await this.store.changeAgentMode(inst.id, modes[nextIndex]);
    } finally {
      this.isChangingMode.set(false);
    }
  }

  onTerminate(): void {
    const inst = this.instance();
    if (inst) {
      this.store.terminateInstance(inst.id);
    }
  }

  onInterrupt(): void {
    const inst = this.instance();
    if (inst && inst.status === 'busy') {
      this.store.interruptInstance(inst.id);
    }
  }

  onCreateChild(): void {
    const inst = this.instance();
    if (inst) {
      this.store.createChildInstance(inst.id);
    }
  }

  onWelcomeSendMessage(message: string): void {
    const workingDir = this.welcomeWorkingDirectory() || '.';
    const provider = this.providerState.getProviderForCreation();
    const model = this.providerState.getModelForCreation();

    this.isCreatingInstance.set(true);
    this.store.createInstanceWithMessage(
      message,
      this.welcomePendingFiles(),
      workingDir,
      provider,
      model
    );
    this.welcomePendingFiles.set([]);
    this.welcomeWorkingDirectory.set(
      this.settingsStore.defaultWorkingDirectory() || null
    );
  }

  async onSelectWelcomeFolder(): Promise<void> {
    const folder = await this.ipc.selectFolder();
    if (folder) {
      this.welcomeWorkingDirectory.set(folder);
    }
  }

  onWelcomeFilesDropped(files: File[]): void {
    this.welcomePendingFiles.update((current) => [...current, ...files]);
  }

  onWelcomeImagesPasted(images: File[]): void {
    this.welcomePendingFiles.update((current) => [...current, ...images]);
  }

  onWelcomeRemoveFile(file: File): void {
    this.welcomePendingFiles.update((files) => files.filter((f) => f !== file));
  }

  async onAddFiles(): Promise<void> {
    const inst = this.instance();
    if (!inst) return;

    const files = await this.selectAndLoadFiles();
    if (files.length > 0) {
      this.draftService.addPendingFiles(inst.id, files);
    }
  }

  async onWelcomeAddFiles(): Promise<void> {
    const files = await this.selectAndLoadFiles();
    if (files.length > 0) {
      this.welcomePendingFiles.update((current) => [...current, ...files]);
    }
  }

  private async selectAndLoadFiles(): Promise<File[]> {
    const filePaths = await this.ipc.selectFiles({ multiple: true });
    if (!filePaths || filePaths.length === 0) {
      return [];
    }

    const files: File[] = [];
    for (const filePath of filePaths) {
      try {
        const response = await fetch(`file://${filePath}`);
        const blob = await response.blob();
        const fileName = filePath.split('/').pop() || 'file';
        const file = new File([blob], fileName, {
          type: blob.type || 'application/octet-stream'
        });
        files.push(file);
      } catch (error) {
        console.warn(`Failed to load file: ${filePath}`, error);
      }
    }
    return files;
  }

  onSelectChild(childId: string): void {
    this.store.setSelectedInstance(childId);
  }
}
