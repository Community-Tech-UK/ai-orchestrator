/**
 * Instance Detail Component - Full view of a selected instance
 */

import {
  Component,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy
} from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
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

        <!-- Input panel with drop zone -->
        <app-drop-zone
          (filesDropped)="onFilesDropped($event)"
          (imagesPasted)="onImagesPasted($event)"
        >
          <app-input-panel
            [instanceId]="inst.id"
            [disabled]="inst.status === 'terminated'"
            [placeholder]="inputPlaceholder()"
            [pendingFiles]="pendingFiles()"
            (sendMessage)="onSendMessage($event)"
            (removeFile)="onRemoveFile($event)"
          />
        </app-drop-zone>

        <!-- Children section -->
        <app-child-instances-panel
          [childrenIds]="inst.childrenIds"
          (selectChild)="onSelectChild($event)"
        />
      </div>
    } @else {
      <div class="no-selection">
        <div class="no-selection-content">
          <div class="no-selection-icon">🤖</div>
          <p class="no-selection-title">No instance selected</p>
          <p class="no-selection-hint">
            Select an instance from the sidebar or create a new one
          </p>
          <button class="btn-create-large" (click)="onCreateNew()">
            + Create New Instance
          </button>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex: 1;
        min-width: 0;
      }

      .instance-detail {
        display: flex;
        flex-direction: column;
        flex: 1;
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

      /* No selection state */
      .no-selection {
        display: flex;
        flex: 1;
        align-items: center;
        justify-content: center;
      }

      .no-selection-content {
        text-align: center;
        max-width: 300px;
      }

      .no-selection-icon {
        font-size: 48px;
        margin-bottom: var(--spacing-md);
      }

      .no-selection-title {
        font-size: 18px;
        font-weight: 500;
        color: var(--text-primary);
        margin-bottom: var(--spacing-xs);
      }

      .no-selection-hint {
        font-size: 14px;
        color: var(--text-secondary);
        margin-bottom: var(--spacing-lg);
      }

      .btn-create-large {
        padding: var(--spacing-md) var(--spacing-xl);
        background: var(--primary-color);
        color: white;
        border-radius: var(--radius-md);
        font-size: 14px;
        font-weight: 500;
        transition: background var(--transition-fast);

        &:hover {
          background: var(--primary-hover);
        }
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstanceDetailComponent {
  private store = inject(InstanceStore);

  instance = this.store.selectedInstance;
  currentActivity = this.store.selectedInstanceActivity;
  pendingFiles = signal<File[]>([]);
  isEditingName = signal(false);

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

  onCreateChild(): void {
    const inst = this.instance();
    if (inst) {
      this.store.createChildInstance(inst.id);
    }
  }

  onCreateNew(): void {
    this.store.createInstance({});
  }

  onSelectChild(childId: string): void {
    this.store.setSelectedInstance(childId);
  }
}
