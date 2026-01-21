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
        (filePathDropped)="onFilePathDropped($event)"
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
                  class="mode-badge"
                  [class.plan]="inst.agentId === 'plan'"
                  [class.review]="inst.agentId === 'review'"
                  [disabled]="isChangingMode()"
                  [title]="'Click to change mode (will restart instance)'"
                  (click)="onCycleAgentMode()"
                >
                  {{ getAgentModeIcon(inst.agentId) }} {{ getAgentModeName(inst.agentId) }}
                </button>
                <span class="separator">•</span>
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
                  [disabled]="isTogglingYolo()"
                  [title]="inst.yoloMode ? 'YOLO Mode: Auto-approve all tool calls without prompting. Click to disable (will restart)' : 'YOLO Mode: Requires manual approval for tool calls. Click to enable auto-approve (will restart)'"
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
            [queuedCount]="queuedMessageCount()"
            [isBusy]="inst.status === 'busy'"
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

      /* Instance Detail - Main conversation area */
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

      /* Header - Refined command bar aesthetic */
      .detail-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--spacing-lg);
        padding-bottom: var(--spacing-md);
        border-bottom: 1px solid var(--border-subtle);
      }

      .instance-identity {
        flex: 1;
        min-width: 0;
      }

      .name-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
      }

      .session-id {
        margin-left: auto;
        font-family: var(--font-mono);
        font-size: 10px;
        letter-spacing: 0.05em;
        color: var(--text-muted);
        background: var(--bg-tertiary);
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-subtle);
      }

      .instance-name {
        font-family: var(--font-display);
        font-size: 20px;
        font-weight: 700;
        letter-spacing: -0.02em;
        margin: 0;
        color: var(--text-primary);

        &.editable {
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: 2px 4px;
          border-radius: var(--radius-sm);
          transition: background var(--transition-fast);

          &:hover {
            background: var(--bg-hover);
          }

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
        font-family: var(--font-display);
        font-size: 20px;
        font-weight: 700;
        letter-spacing: -0.02em;
        padding: 4px 10px;
        border: 2px solid var(--primary-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        color: var(--text-primary);
        outline: none;
        min-width: 200px;
        box-shadow: 0 0 0 4px rgba(var(--primary-rgb), 0.15);
      }

      .instance-meta {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: 12px;
        color: var(--text-secondary);
        margin-top: var(--spacing-sm);
        flex-wrap: wrap;
      }

      .separator {
        color: var(--border-color);
        font-size: 8px;
      }

      .working-dir-btn {
        max-width: 300px;
        font-family: var(--font-mono);
        font-size: 11px;
        letter-spacing: 0.02em;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        padding: 4px 10px;
        color: var(--text-muted);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          border-color: var(--primary-color);
          color: var(--text-primary);
          background: rgba(var(--primary-rgb), 0.1);
        }
      }

      /* Mode Badge - Pill style with glow */
      .mode-badge {
        padding: 4px 10px;
        border: none;
        border-radius: 12px;
        font-family: var(--font-mono);
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        color: white;
        cursor: pointer;
        transition: all var(--transition-fast);
        box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);

        &:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);
        }

        &.plan {
          background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
          box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
          &:hover {
            box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
          }
        }

        &.review {
          background: linear-gradient(135deg, var(--primary-color) 0%, var(--primary-hover) 100%);
          box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.3);
          &:hover {
            box-shadow: 0 4px 12px rgba(var(--primary-rgb), 0.4);
          }
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          transform: none;
        }
      }

      /* YOLO Badge - Danger aesthetic */
      .yolo-badge {
        padding: 4px 10px;
        border: 1px solid var(--border-subtle);
        border-radius: 12px;
        font-family: var(--font-mono);
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        background: var(--bg-tertiary);
        color: var(--text-muted);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: var(--bg-hover);
          border-color: var(--border-color);
        }

        &.active {
          background: linear-gradient(135deg, var(--primary-color), #ef4444);
          border: none;
          color: var(--bg-primary);
          box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.4);
          animation: glow 2s ease-in-out infinite;

          &:hover {
            box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.5);
          }
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      /* Header Actions - Refined button group */
      .header-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .btn-action {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-md);
        font-family: var(--font-display);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.01em;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover:not(:disabled) {
          background: var(--bg-hover);
          border-color: var(--border-color);
          color: var(--text-primary);
        }

        &:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
      }

      .btn-danger {
        color: var(--error-color);
        border-color: rgba(var(--error-rgb), 0.3);

        &:hover:not(:disabled) {
          background: rgba(var(--error-rgb), 0.1);
          border-color: var(--error-color);
          box-shadow: 0 0 12px rgba(var(--error-rgb), 0.2);
        }
      }

      .btn-interrupt {
        background: rgba(var(--primary-rgb), 0.15);
        color: var(--primary-color);
        border: 1px solid rgba(var(--primary-rgb), 0.4);
        animation: pulse 1.5s ease-in-out infinite;

        &:hover:not(:disabled) {
          background: var(--primary-color);
          border-color: var(--primary-color);
          color: var(--bg-primary);
          box-shadow: 0 0 16px rgba(var(--primary-rgb), 0.5);
        }
      }

      .btn-primary {
        background: linear-gradient(135deg, var(--primary-color) 0%, var(--primary-hover) 100%);
        border: none;
        color: var(--bg-primary);
        box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.3);

        &:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(var(--primary-rgb), 0.4);
        }
      }

      /* Context Section */
      .context-section {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--bg-secondary);
        border-radius: var(--radius-md);
        border: 1px solid var(--border-subtle);
      }

      /* Output Section - Chat area */
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

      /* Creating View - Startup animation */
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
        background: radial-gradient(ellipse 60% 40% at 50% 40%, rgba(var(--primary-rgb), 0.1), transparent);
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

      .creating-text {
        font-family: var(--font-mono);
        font-size: 13px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--text-muted);
        margin: 0;
        animation: pulse 2s ease-in-out infinite;
      }

      /* Welcome View - Premium onboarding experience */
      .welcome-view {
        display: flex;
        flex: 1;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--spacing-xl);
        gap: var(--spacing-xl);
        background: var(--bg-primary);
        position: relative;
        overflow: hidden;
      }

      .welcome-view::before {
        content: '';
        position: absolute;
        inset: 0;
        background:
          radial-gradient(ellipse 80% 50% at 50% -10%, rgba(var(--primary-rgb), 0.12), transparent),
          radial-gradient(circle at 80% 80%, rgba(var(--secondary-rgb), 0.08), transparent);
        pointer-events: none;
      }

      .welcome-content {
        text-align: center;
        max-width: 480px;
        position: relative;
        z-index: 1;
        animation: fadeInUp 0.6s ease-out;
      }

      .welcome-icon {
        font-size: 72px;
        margin-bottom: var(--spacing-lg);
        filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.3));
      }

      .welcome-title {
        font-family: var(--font-display);
        font-size: 32px;
        font-weight: 700;
        letter-spacing: -0.03em;
        color: var(--text-primary);
        margin: 0 0 var(--spacing-sm) 0;
        background: linear-gradient(135deg, var(--text-primary) 0%, var(--primary-color) 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .welcome-hint {
        font-size: 15px;
        color: var(--text-muted);
        margin: 0;
        line-height: 1.5;
      }

      .welcome-input {
        width: 100%;
        max-width: 640px;
        position: relative;
        z-index: 1;
        animation: fadeInUp 0.6s ease-out 0.15s both;
      }

      .welcome-folder-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-sm);
        margin-top: var(--spacing-lg);
        padding: var(--spacing-sm) var(--spacing-lg);
        background: var(--bg-secondary);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        color: var(--text-muted);
        font-family: var(--font-mono);
        font-size: 13px;
        cursor: pointer;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        transition: all var(--transition-fast);

        &:hover {
          border-color: var(--primary-color);
          color: var(--text-primary);
          background: rgba(var(--primary-rgb), 0.1);
          box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.15);
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
  isChangingMode = signal(false);
  isTogglingYolo = signal(false);

  // Queue count - computed from store (re-evaluated when instance changes)
  queuedMessageCount = computed(() => {
    const inst = this.instance();
    if (!inst) return 0;
    return this.store.getQueuedMessageCount(inst.id);
  });

  constructor() {
    // Initialize welcomeWorkingDirectory from settings
    effect(() => {
      const defaultDir = this.settingsStore.defaultWorkingDirectory();
      if (!this.welcomeWorkingDirectory()) {
        this.welcomeWorkingDirectory.set(defaultDir || null);
      }
    });

    // Clear creating flag and pending files when instance changes
    effect(() => {
      const inst = this.instance();
      if (inst) {
        this.isCreatingInstance.set(false);
      }
      // Clear pending files when switching instances
      this.pendingFiles.set([]);
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

  async onFilePathDropped(filePath: string): Promise<void> {
    // File path dropped from file explorer - fetch file content via IPC
    const ipc = (window as any).electronAPI;
    if (!ipc) return;

    try {
      const stats = await ipc.getFileStats(filePath);
      if (!stats.success || !stats.data) return;

      // For directories, we can't add them as attachments yet
      if (stats.data.isDirectory) {
        console.log('Directory dropped - not supported yet:', filePath);
        return;
      }

      // Read file content via fetch (works for local files in Electron)
      const response = await fetch(`file://${filePath}`);
      const blob = await response.blob();

      // Create a File object from the blob
      const fileName = filePath.split('/').pop() || 'file';
      const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });

      this.pendingFiles.update((current) => [...current, file]);
    } catch (error) {
      console.error('Failed to load file from path:', error);
    }
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

  async onToggleYolo(): Promise<void> {
    const inst = this.instance();
    if (!inst) return;

    // Prevent rapid clicks from spawning multiple instances
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

    // Prevent rapid clicks from spawning multiple instances
    if (this.isChangingMode()) return;

    // Cycle through modes: build -> plan -> review -> build
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

  getAgentModeIcon(agentId?: string): string {
    switch (agentId) {
      case 'plan': return '🗺️';
      case 'review': return '👁️';
      default: return '🔨';
    }
  }

  getAgentModeName(agentId?: string): string {
    switch (agentId) {
      case 'plan': return 'Plan';
      case 'review': return 'Review';
      default: return 'Build';
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
