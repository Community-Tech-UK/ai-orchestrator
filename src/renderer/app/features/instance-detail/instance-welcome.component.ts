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
            <p class="welcome-eyebrow">Operator Workspace</p>
            <h1 class="welcome-title">Start with a brief, not a control panel.</h1>
            <p class="welcome-hint">
              Launch a session, point it at the right folder, and let the rest of the orchestration stack stay in the background until you need it.
            </p>

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
            </div>
          </div>

          <app-node-picker
            [selectedNodeId]="selectedNodeId()"
            [selectedCli]="selectedCli()"
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
              <span class="welcome-composer-hint">Describe the outcome, constraints, and context.</span>
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
        padding: 40px 32px;
        background:
          radial-gradient(circle at 18% 18%, rgba(var(--secondary-rgb), 0.12), transparent 26%),
          radial-gradient(circle at 82% 82%, rgba(var(--primary-rgb), 0.09), transparent 24%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 22%),
          var(--bg-primary);
        position: relative;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      .welcome-shell {
        width: min(980px, 100%);
        display: flex;
        flex-direction: column;
        gap: 26px;
        position: relative;
        z-index: 1;
        margin-block: auto;
      }

      .welcome-copy {
        display: flex;
        flex-direction: column;
        gap: 18px;
        animation: fadeInUp 0.6s ease-out;
        max-width: 720px;
        z-index: 2;
      }

      .welcome-eyebrow {
        font-family: var(--font-mono);
        font-size: 11px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--text-muted);
      }

      .welcome-title {
        font-family: var(--font-display);
        font-size: clamp(34px, 5vw, 52px);
        font-weight: 600;
        letter-spacing: -0.03em;
        color: var(--text-primary);
        line-height: 0.94;
        max-width: 12ch;
      }

      .welcome-hint {
        max-width: 46ch;
        font-size: 17px;
        color: var(--text-secondary);
        margin: 0;
        line-height: 1.75;
      }

      .welcome-folder-wrapper {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: min(520px, 100%);
        padding: 18px 20px;
        border-radius: 22px;
        border: 1px solid rgba(255, 255, 255, 0.07);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0)),
          rgba(255, 255, 255, 0.03);
        backdrop-filter: blur(18px);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.18);
      }

      .folder-label {
        font-family: var(--font-mono);
        font-size: 10px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
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

      .project-context-loading {
        font-family: var(--font-mono);
        font-size: 10px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
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
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .context-pill-draft {
        border-color: rgba(var(--primary-rgb), 0.2);
        background: rgba(var(--primary-rgb), 0.1);
        color: rgba(212, 233, 190, 0.92);
      }

      .welcome-input-shell {
        display: flex;
        flex-direction: column;
        gap: 16px;
        min-width: 0;
        animation: fadeInUp 0.6s ease-out 0.15s both;
        width: 100%;
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
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--text-muted);
      }

      .welcome-composer-hint {
        color: var(--text-secondary);
        font-size: 15px;
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
        letter-spacing: 0.06em;
        text-transform: uppercase;
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
          font-size: clamp(32px, 10vw, 46px);
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
