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
import { ElectronIpcService } from '../../core/services/electron-ipc.service';
import { OutputStreamComponent } from './output-stream.component';
import { ContextBarComponent } from './context-bar.component';
import { InputPanelComponent } from './input-panel.component';
import { StatusIndicatorComponent } from '../instance-list/status-indicator.component';
import { DropZoneComponent } from '../file-drop/drop-zone.component';
import { ActivityStatusComponent } from './activity-status.component';
import { ChildInstancesPanelComponent } from './child-instances-panel.component';
import { TodoListComponent } from './todo-list.component';

@Component({
  selector: 'app-instance-detail',
  standalone: true,
  imports: [
    OutputStreamComponent,
    ContextBarComponent,
    InputPanelComponent,
    StatusIndicatorComponent,
    DropZoneComponent,
    ActivityStatusComponent,
    ChildInstancesPanelComponent,
    TodoListComponent
  ],
  template: `
    @if (instance(); as inst) {
      <app-drop-zone
        class="full-drop-zone"
        (filesDropped)="onFilesDropped($event)"
        (imagesPasted)="onImagesPasted($event)"
      >
        <div class="instance-detail">
          <!-- Header -->
          <div class="detail-header">
            <div class="instance-identity">
              <div class="name-row">
                <app-status-indicator [status]="inst.status" />
                @if (isEditingName()) {
                  <input
                    type="text"
                    class="name-input"
                    [value]="inst.displayName"
                    (keydown.enter)="onSaveName($event)"
                    (keydown.escape)="onCancelEditName()"
                    (blur)="onSaveName($event)"
                    #nameInput
                  />
                } @else {
                  <h2
                    class="instance-name editable"
                    title="Click to rename"
                    (click)="onStartEditName()"
                  >
                    {{ inst.displayName }}
                    <span class="edit-icon">✏️</span>
                  </h2>
                }
                <span class="session-id mono">{{ inst.sessionId }}</span>
              </div>
              <div class="instance-meta">
                <button
                  class="working-dir-btn mono truncate"
                  [title]="inst.workingDirectory || 'Click to select a working folder'"
                  (click)="onSelectFolder()"
                >
                  📁 {{ inst.workingDirectory || 'No folder selected' }}
                </button>
                <span class="separator">•</span>
                <button
                  class="yolo-badge"
                  [class.active]="inst.yoloMode"
                  [title]="inst.yoloMode ? 'YOLO Mode ON - Click to disable (will restart)' : 'YOLO Mode OFF - Click to enable (will restart)'"
                  (click)="onToggleYolo()"
                >
                  ⚡ YOLO {{ inst.yoloMode ? 'ON' : 'OFF' }}
                </button>
              </div>
            </div>

            <div class="header-actions">
              @if (inst.status === 'busy') {
                <button
                  class="btn-action btn-interrupt"
                  title="Interrupt Claude (Esc)"
                  (click)="onInterrupt()"
                >
                  ⏸ Interrupt
                </button>
              }
              <button
                class="btn-action"
                title="Restart instance"
                (click)="onRestart()"
                [disabled]="inst.status === 'initializing'"
              >
                ↻ Restart
              </button>
              <button
                class="btn-action btn-danger"
                title="Terminate instance"
                (click)="onTerminate()"
              >
                × Terminate
              </button>
              <button
                class="btn-action btn-primary"
                title="Create child instance"
                (click)="onCreateChild()"
              >
                + Child
              </button>
            </div>
          </div>

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
            />
            <!-- Activity status (shown when processing) - appears at bottom of conversation -->
            @if (inst.status === 'busy' || inst.status === 'initializing') {
              <app-activity-status
                [status]="inst.status"
                [activity]="currentActivity()"
              />
            }
          </div>

          <!-- Input panel -->
          <app-input-panel
            [instanceId]="inst.id"
            [disabled]="inst.status === 'terminated'"
            [placeholder]="inputPlaceholder()"
            [pendingFiles]="pendingFiles()"
            (sendMessage)="onSendMessage($event)"
            (removeFile)="onRemoveFile($event)"
            (addFiles)="onAddFiles()"
          />

          <!-- Children section -->
          <app-child-instances-panel
            [childrenIds]="inst.childrenIds"
            (selectChild)="onSelectChild($event)"
          />
        </div>
      </app-drop-zone>
    } @else if (isCreatingInstance()) {
      <!-- Show loading state while creating instance -->
      <div class="creating-view">
        <div class="creating-content">
          <div class="creating-spinner"></div>
          <p class="creating-text">Starting conversation...</p>
        </div>
      </div>
    } @else {
      <app-drop-zone
        class="full-drop-zone"
        (filesDropped)="onWelcomeFilesDropped($event)"
        (imagesPasted)="onWelcomeImagesPasted($event)"
      >
        <div class="welcome-view">
          <div class="welcome-content">
            <div class="welcome-icon">🤖</div>
            <h1 class="welcome-title">Claude Orchestrator</h1>
            <p class="welcome-hint">Start a conversation to create a new instance</p>

            <!-- Folder selector -->
            <button
              class="welcome-folder-btn"
              (click)="onSelectWelcomeFolder()"
              [title]="welcomeWorkingDirectory() || 'Click to select a working folder'"
            >
              📁 {{ welcomeWorkingDirectory() || 'Select working folder...' }}
            </button>
          </div>
          <div class="welcome-input">
            <app-input-panel
              instanceId="new"
              [disabled]="false"
              placeholder="What would you like to work on?"
              [pendingFiles]="welcomePendingFiles()"
              (sendMessage)="onWelcomeSendMessage($event)"
              (removeFile)="onWelcomeRemoveFile($event)"
              (addFiles)="onWelcomeAddFiles()"
            />
          </div>
        </div>
      </app-drop-zone>
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
        padding: var(--spacing-md);
        gap: var(--spacing-md);
      }

      .detail-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--spacing-md);
      }

      .instance-identity {
        flex: 1;
        min-width: 0;
      }

      .name-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .session-id {
        margin-left: auto;
        font-size: 11px;
        color: var(--text-muted);
        background: var(--bg-tertiary);
        padding: 2px 8px;
        border-radius: var(--radius-sm);
      }

      .instance-name {
        font-size: 18px;
        font-weight: 600;
        margin: 0;
        color: var(--text-primary);

        &.editable {
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);

          .edit-icon {
            opacity: 0;
            font-size: 14px;
            transition: opacity var(--transition-fast);
          }

          &:hover .edit-icon {
            opacity: 0.6;
          }
        }
      }

      .name-input {
        font-size: 18px;
        font-weight: 600;
        padding: 2px 8px;
        border: 2px solid var(--primary-color);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        outline: none;
        min-width: 200px;
      }

      .instance-meta {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: 12px;
        color: var(--text-secondary);
        margin-top: var(--spacing-xs);
      }

      .separator {
        color: var(--text-muted);
      }

      .working-dir-btn {
        max-width: 300px;
        background: transparent;
        border: 1px dashed var(--border-color);
        border-radius: var(--radius-sm);
        padding: 2px 8px;
        color: var(--text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          border-color: var(--primary-color);
          color: var(--text-primary);
          background: var(--bg-tertiary);
        }
      }

      .yolo-badge {
        padding: 2px 8px;
        border: none;
        border-radius: var(--radius-sm);
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--bg-tertiary);
        color: var(--text-muted);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: var(--bg-hover);
        }

        &.active {
          background: linear-gradient(135deg, #f59e0b, #ef4444);
          color: white;

          &:hover {
            background: linear-gradient(135deg, #d97706, #dc2626);
          }
        }
      }

      .header-actions {
        display: flex;
        gap: var(--spacing-sm);
      }

      .btn-action {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        font-size: 13px;
        font-weight: 500;
        background: var(--bg-tertiary);
        color: var(--text-primary);
        transition: background var(--transition-fast);

        &:hover:not(:disabled) {
          background: var(--bg-hover);
        }

        &:disabled {
          opacity: 0.5;
        }
      }

      .btn-danger {
        color: var(--error-color);

        &:hover:not(:disabled) {
          background: var(--error-bg);
        }
      }

      .btn-interrupt {
        background: var(--warning-bg, #fef3c7);
        color: var(--warning-color, #d97706);
        border: 1px solid var(--warning-color, #d97706);
        animation: pulse 2s ease-in-out infinite;

        &:hover:not(:disabled) {
          background: var(--warning-color, #d97706);
          color: white;
        }
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }

      .btn-primary {
        background: var(--primary-color);
        color: white;

        &:hover:not(:disabled) {
          background: var(--primary-hover);
        }
      }

      .context-section {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--bg-secondary);
        border-radius: var(--radius-md);
      }

      .output-section {
        flex: 1;
        min-height: 0; /* Important for flex children to scroll */
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .output-section app-output-stream {
        flex: 1;
        min-height: 0; /* Allow scrolling within flex container */
      }

      .output-section app-activity-status {
        flex-shrink: 0;
        padding: 0 var(--spacing-md);
        padding-bottom: var(--spacing-sm);
      }

      /* Welcome view (no selection) */
      .creating-view {
        display: flex;
        flex: 1;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
      }

      .creating-content {
        text-align: center;
      }

      .creating-spinner {
        width: 40px;
        height: 40px;
        border: 3px solid var(--bg-tertiary);
        border-top-color: var(--primary-color);
        border-radius: 50%;
        margin: 0 auto var(--spacing-md);
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .creating-text {
        font-size: 16px;
        color: var(--text-secondary);
        margin: 0;
      }

      .welcome-view {
        display: flex;
        flex: 1;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        gap: var(--spacing-xl);
      }

      .welcome-content {
        text-align: center;
        max-width: 400px;
      }

      .welcome-icon {
        font-size: 64px;
        margin-bottom: var(--spacing-md);
      }

      .welcome-title {
        font-size: 28px;
        font-weight: 600;
        color: var(--text-primary);
        margin: 0 0 var(--spacing-sm) 0;
      }

      .welcome-hint {
        font-size: 16px;
        color: var(--text-secondary);
        margin: 0;
      }

      .welcome-input {
        width: 100%;
        max-width: 600px;
      }

      .welcome-folder-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-sm);
        margin-top: var(--spacing-md);
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--bg-secondary);
        border: 1px dashed var(--border-color);
        border-radius: var(--radius-md);
        color: var(--text-secondary);
        font-size: 14px;
        cursor: pointer;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        transition: all var(--transition-fast);

        &:hover {
          border-color: var(--primary-color);
          color: var(--text-primary);
          background: var(--bg-tertiary);
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

  instance = this.store.selectedInstance;
  currentActivity = this.store.selectedInstanceActivity;
  pendingFiles = signal<File[]>([]);
  welcomePendingFiles = signal<File[]>([]);
  welcomeWorkingDirectory = signal<string | null>(null);
  isEditingName = signal(false);
  isCreatingInstance = signal(false);

  constructor() {
    // Initialize welcomeWorkingDirectory from settings
    effect(() => {
      const defaultDir = this.settingsStore.defaultWorkingDirectory();
      if (!this.welcomeWorkingDirectory()) {
        this.welcomeWorkingDirectory.set(defaultDir || null);
      }
    });

    // Clear creating flag when instance is selected
    effect(() => {
      if (this.instance()) {
        this.isCreatingInstance.set(false);
      }
    });
  }

  /**
   * Handle Escape key to interrupt Claude
   */
  @HostListener('window:keydown', ['$event'])
  handleKeyboardShortcut(event: KeyboardEvent): void {
    // Use Escape key to interrupt - avoids conflict with copy/paste
    if (event.key === 'Escape') {
      const inst = this.instance();
      if (inst && inst.status === 'busy') {
        event.preventDefault();
        this.onInterrupt();
      }
    }
  }

  inputPlaceholder = computed(() => {
    const inst = this.instance();
    if (!inst) return '';

    switch (inst.status) {
      case 'waiting_for_input':
        return 'Claude is waiting for your response...';
      case 'busy':
        return 'Processing...';
      case 'terminated':
        return 'Instance terminated';
      default:
        return 'Send a message to Claude...';
    }
  });

  onSendMessage(message: string): void {
    const inst = this.instance();
    if (!inst) return;

    this.store.sendInput(inst.id, message, this.pendingFiles());
    this.pendingFiles.set([]);
  }

  onFilesDropped(files: File[]): void {
    this.pendingFiles.update((current) => [...current, ...files]);
  }

  onImagesPasted(images: File[]): void {
    this.pendingFiles.update((current) => [...current, ...images]);
  }

  onRemoveFile(file: File): void {
    this.pendingFiles.update((files) => files.filter((f) => f !== file));
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
    // Focus input after Angular renders it
    setTimeout(() => {
      const input = document.querySelector('.name-input') as HTMLInputElement;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  onSaveName(event: Event): void {
    const input = event.target as HTMLInputElement;
    const newName = input.value.trim();
    const inst = this.instance();

    if (newName && inst && newName !== inst.displayName) {
      this.store.renameInstance(inst.id, newName);
    }
    this.isEditingName.set(false);
  }

  onCancelEditName(): void {
    this.isEditingName.set(false);
  }

  onToggleYolo(): void {
    const inst = this.instance();
    if (inst) {
      this.store.toggleYoloMode(inst.id);
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
    this.isCreatingInstance.set(true);
    this.store.createInstanceWithMessage(message, this.welcomePendingFiles(), workingDir);
    this.welcomePendingFiles.set([]);
    // Reset to default for next time
    this.welcomeWorkingDirectory.set(this.settingsStore.defaultWorkingDirectory() || null);
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
    const files = await this.selectAndLoadFiles();
    if (files.length > 0) {
      this.pendingFiles.update((current) => [...current, ...files]);
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
        const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
        files.push(file);
      } catch (error) {
        console.warn(`Failed to load file: ${filePath}`, error);
      }
    }
    return files;
  }

  onCreateNew(): void {
    this.store.createInstance({});
  }

  onSelectChild(childId: string): void {
    this.store.setSelectedInstance(childId);
  }
}
