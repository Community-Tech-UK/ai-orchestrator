/**
 * Instance Welcome Component - Welcome view for creating new conversations
 */

import {
  Component,
  effect,
  input,
  output,
  signal,
  ChangeDetectionStrategy
} from '@angular/core';
import { DropZoneComponent } from '../file-drop/drop-zone.component';
import { InputPanelComponent } from './input-panel.component';
import { RecentDirectoriesDropdownComponent } from '../../shared/components/recent-directories-dropdown/recent-directories-dropdown.component';
import { NodePickerComponent } from '../../shared/components/node-picker/node-picker.component';
import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';
import type { ModelRuntimeTarget } from '../../../../shared/types/local-model-runtime.types';

interface WelcomeProjectContext {
  branch: string | null;
  hasChanges: boolean;
  isRepo: boolean;
  lastAccessed: number | null;
  draftUpdatedAt: number | null;
  hasDraft: boolean;
}

@Component({
  selector: 'app-instance-welcome',
  standalone: true,
  imports: [DropZoneComponent, InputPanelComponent, RecentDirectoriesDropdownComponent, NodePickerComponent],
  template: `
    <app-drop-zone
      class="full-drop-zone"
      (filesDropped)="filesDropped.emit($event)"
      (imagesPasted)="imagesPasted.emit($event)"
      (folderDropped)="folderDropped.emit($event)"
      (filePathDropped)="filePathDropped.emit($event)"
      (filePathsDropped)="filePathsDropped.emit($event)"
    >
      <div class="welcome-view">
        <div class="welcome-shell">
          <div class="welcome-copy">
            <h1 class="welcome-title">Start with a brief.</h1>

            <div class="welcome-folder-wrapper">
              <span class="folder-label">Working directory</span>
              <app-recent-directories-dropdown
                [currentPath]="workingDirectory() || ''"
                placeholder="Select working folder..."
                [selectedNodeId]="selectedNodeId()"
                (folderSelected)="selectFolder.emit($event)"
                (browseRemote)="browseRemote.emit($event)"
              />

              <div class="project-context-shell">
                @if (isProjectContextLoading()) {
                  <div class="project-context project-context-loading">Loading project context...</div>
                } @else if (projectContext(); as context) {
                  <div class="project-context">
                    @if (context.isRepo) {
                      <span class="context-pill">
                        {{ context.hasChanges ? 'Dirty repo' : 'Clean repo' }}
                      </span>
                      @if (context.branch) {
                        <span class="context-pill">Branch {{ context.branch }}</span>
                      }
                    } @else {
                      <span class="context-pill">Plain folder</span>
                    }
                    @if (context.lastAccessed) {
                      <span class="context-pill">Recent {{ formatRelativeTime(context.lastAccessed) }}</span>
                    }
                    @if (context.hasDraft && context.draftUpdatedAt) {
                      <span class="context-pill context-pill-draft">
                        Draft {{ formatRelativeTime(context.draftUpdatedAt) }}
                      </span>
                    }
                  </div>
                }
              </div>

              @if (canShowFileExplorer() || canShowSourceControl()) {
                <div class="workspace-actions" aria-label="Workspace tools">
                  @if (canShowFileExplorer()) {
                    <button
                      type="button"
                      class="workspace-action-btn"
                      [class.active]="isFileExplorerOpen()"
                      [title]="isFileExplorerOpen() ? 'Hide file browser' : 'Open file browser'"
                      (click)="toggleFileExplorer.emit()"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                        aria-hidden="true">
                        <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H10l2 2h7.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z"/>
                      </svg>
                      <span>Files</span>
                    </button>
                  }
                  @if (canShowSourceControl()) {
                    <button
                      type="button"
                      class="workspace-action-btn"
                      [class.active]="isSourceControlOpen()"
                      [title]="sourceControlButtonTitle()"
                      (click)="toggleSourceControl.emit()"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                        aria-hidden="true">
                        <circle cx="6" cy="6" r="2.2" />
                        <circle cx="6" cy="18" r="2.2" />
                        <circle cx="18" cy="6" r="2.2" />
                        <line x1="6" y1="8.2" x2="6" y2="15.8" />
                        <path d="M18 8.2c0 5.4-4.2 8.4-9 9.4" />
                      </svg>
                      <span>Git</span>
                      @if (sourceControlChangeCount() > 0) {
                        <span class="workspace-action-count">{{ sourceControlPipLabel() }}</span>
                      }
                    </button>
                  }
                </div>
              }
            </div>
          </div>

          <app-node-picker
            [selectedNodeId]="selectedNodeId()"
            [selectedCli]="selectedCli()"
            [selectedLocalModelTarget]="selectedLocalModelTarget()"
            (nodeSelected)="onNodeSelected($event)"
          />

          <div class="welcome-input-shell">
            <div class="welcome-input-header">
              <div class="welcome-heading-row">
                <span class="welcome-composer-label">New session</span>
                @if (projectContext()?.hasDraft) {
                  <button type="button" class="discard-draft-btn" (click)="discardDraft.emit()">
                    Discard draft
                  </button>
                }
              </div>
            </div>
            <div class="welcome-input">
              <app-input-panel
                instanceId="new"
                [disabled]="false"
                placeholder="Plan the work, review code, investigate a bug, or coordinate a multi-agent task..."
                [pendingFiles]="pendingFiles()"
                [pendingFolders]="pendingFolders()"
                [workingDirectory]="workingDirectory() || null"
                [loopChatId]="null"
                (sendMessage)="sendMessage.emit($event)"
                (startSessionWithWorkflow)="startSessionWithWorkflow.emit($event)"
                (removeFile)="removeFile.emit($event)"
                (removeFolder)="removeFolder.emit($event)"
                (addFiles)="addFiles.emit()"
                (loopStartRequested)="loopStartRequested.emit($event)"
              />
            </div>
          </div>
        </div>
      </div>
    </app-drop-zone>
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

      .welcome-view {
        display: flex;
        flex: 1;
        align-items: flex-start;
        justify-content: center;
        padding: 28px 32px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 22%),
          var(--bg-primary);
        position: relative;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      .welcome-shell {
        --welcome-layer-content: var(--z-base);
        --welcome-layer-composer: calc(var(--z-base) + 1);
        --welcome-layer-open-menu: calc(var(--z-base) + 2);

        width: min(680px, 100%);
        display: flex;
        flex-direction: column;
        gap: 18px;
        position: relative;
        z-index: var(--z-base);
        isolation: isolate;
        margin-block: auto;
      }

      .welcome-copy {
        display: flex;
        flex-direction: column;
        gap: 14px;
        animation: fadeInUp 0.6s ease-out;
        width: 100%;
        position: relative;
        z-index: var(--welcome-layer-content);
      }

      .welcome-copy:has(app-recent-directories-dropdown.dropdown-open) {
        z-index: var(--welcome-layer-open-menu);
      }

      .welcome-title {
        font-family: var(--font-display);
        font-size: clamp(22px, 2.8vw, 32px);
        font-weight: 600;
        letter-spacing: -0.02em;
        color: var(--text-primary);
        line-height: 1.05;
        max-width: 22ch;
      }

      .welcome-folder-wrapper {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.07);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0)),
          var(--bg-elevated, rgba(255, 255, 255, 0.03));
      }

      .folder-label {
        font-family: var(--font-mono);
        font-size: 10px;
        font-weight: 600;
        color: var(--text-muted);
      }

      .project-context {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 4px;
      }

      .project-context-shell {
        min-height: 32px;
      }

      .workspace-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 6px;
      }

      .workspace-action-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 32px;
        padding: 0 12px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        color: var(--text-secondary);
        font-family: var(--font-mono);
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .workspace-action-btn:hover {
        color: var(--text-primary);
        border-color: rgba(var(--primary-rgb), 0.22);
        background: rgba(var(--primary-rgb), 0.08);
      }

      .workspace-action-btn.active {
        color: var(--text-primary);
        border-color: rgba(var(--primary-rgb), 0.3);
        background: rgba(var(--primary-rgb), 0.12);
      }

      .workspace-action-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 999px;
        background: rgba(var(--primary-rgb), 0.18);
        color: rgba(212, 233, 190, 0.92);
        font-size: 10px;
        letter-spacing: 0;
      }

      .project-context-loading {
        font-family: var(--font-mono);
        font-size: 10px;
        font-weight: 600;
        color: var(--text-muted);
      }

      .context-pill {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 0 10px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        color: var(--text-secondary);
        font-family: var(--font-mono);
        font-size: 10px;
        font-weight: 600;
      }

      .context-pill-draft {
        border-color: rgba(var(--primary-rgb), 0.2);
        background: rgba(var(--primary-rgb), 0.1);
        color: rgba(212, 233, 190, 0.92);
      }

      .welcome-input-shell {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
        animation: fadeInUp 0.6s ease-out 0.15s both;
        width: 100%;
        position: relative;
        z-index: var(--welcome-layer-composer);
      }

      app-node-picker {
        position: relative;
        z-index: var(--welcome-layer-content);
      }

      app-node-picker.picker-open {
        z-index: var(--welcome-layer-open-menu);
      }

      .welcome-input-header {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .welcome-heading-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .welcome-composer-label {
        font-family: var(--font-mono);
        font-size: 10px;
        font-weight: 600;
        color: var(--text-muted);
      }

      .discard-draft-btn {
        height: 28px;
        padding: 0 12px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        color: var(--text-secondary);
        font-family: var(--font-mono);
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .discard-draft-btn:hover {
        color: var(--text-primary);
        border-color: rgba(var(--warning-rgb), 0.22);
        background: rgba(var(--warning-rgb), 0.08);
      }

      .welcome-input {
        width: 100%;
      }

      @media (max-width: 960px) {
        .welcome-copy {
          text-align: left;
        }

        .welcome-title {
          font-size: clamp(22px, 6vw, 30px);
        }
      }

      @media (max-width: 640px) {
        .welcome-view {
          padding: 20px;
        }

        .welcome-shell {
          gap: 20px;
        }
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstanceWelcomeComponent {
  workingDirectory = input<string | null>(null);
  pendingFiles = input<File[]>([]);
  pendingFolders = input<string[]>([]);
  projectContext = input<WelcomeProjectContext | null>(null);
  isProjectContextLoading = input(false);
  selectedCli = input<string>('auto');
  selectedLocalModelTarget = input<ModelRuntimeTarget | null>(null);
  canShowFileExplorer = input(false);
  isFileExplorerOpen = input(false);
  canShowSourceControl = input(false);
  isSourceControlOpen = input(false);
  sourceControlChangeCount = input(0);

  // Node picker state — synced from parent when the draft context changes,
  // but also writable locally when the user picks a node manually.
  initialNodeId = input<string | null>(null);
  selectedNodeId = signal<string | null>(null);

  constructor() {
    // Keep local node selection in sync with parent-provided initial value
    // (e.g. when switching between instance tabs or restoring a draft that
    // was previously used with a remote node).
    effect(() => {
      this.selectedNodeId.set(this.initialNodeId());
    });
  }

  // Actions
  selectFolder = output<string>();
  sendMessage = output<string>();
  startSessionWithWorkflow = output<{ message: string; templateId: string }>();
  nodeChange = output<string | null>();
  toggleFileExplorer = output<void>();
  toggleSourceControl = output<void>();
  filesDropped = output<File[]>();
  imagesPasted = output<File[]>();
  folderDropped = output<string>();
  filePathDropped = output<string>();
  filePathsDropped = output<string[]>();
  removeFile = output<File>();
  removeFolder = output<string>();
  discardDraft = output<void>();
  addFiles = output<void>();
  browseRemote = output<string>();
  loopStartRequested = output<{
    config: LoopStartConfigInput;
    firstMessage: string;
    attachments: { name: string; data: Uint8Array }[];
    onResolved: (ok: boolean, error?: string) => void;
  }>();

  onNodeSelected(nodeId: string | null): void {
    this.selectedNodeId.set(nodeId);
    this.nodeChange.emit(nodeId);
  }

  sourceControlPipLabel(): string {
    const n = this.sourceControlChangeCount();
    if (n <= 0) return '';
    return n > 99 ? '99+' : String(n);
  }

  sourceControlButtonTitle(): string {
    const n = this.sourceControlChangeCount();
    if (this.isSourceControlOpen()) return 'Hide source control';
    if (n <= 0) return 'Open source control';
    if (n === 1) return 'Open source control (1 change)';
    return `Open source control (${n} changes)`;
  }

  formatRelativeTime(timestamp: number): string {
    const delta = timestamp - Date.now();
    const seconds = Math.round(delta / 1000);

    if (Math.abs(seconds) < 60) {
      return 'just now';
    }

    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) {
      return `${Math.abs(minutes)}m ago`;
    }

    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) {
      return `${Math.abs(hours)}h ago`;
    }

    const days = Math.round(hours / 24);
    if (Math.abs(days) < 7) {
      return `${Math.abs(days)}d ago`;
    }

    const weeks = Math.round(days / 7);
    return `${Math.abs(weeks)}w ago`;
  }
}
