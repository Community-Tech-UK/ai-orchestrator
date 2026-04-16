/**
 * Instance Detail Component - Full view of a selected instance
 */

import {
  Component,
  inject,
  signal,
  computed,
  input,
  output,
  viewChild,
  ChangeDetectionStrategy,
  HostListener,
  effect
} from '@angular/core';
import { ContextWarningComponent } from './context-warning.component';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ElectronIpcService, RecentDirectoriesIpcService } from '../../core/services/ipc';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { DraftService } from '../../core/services/draft.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';
import { PROVIDER_MODEL_LIST } from '../../../../shared/types/provider.types';
import { OutputStreamComponent } from './output-stream.component';
import { InputPanelComponent } from './input-panel.component';
import { DropZoneComponent } from '../file-drop/drop-zone.component';
import { ActivityStatusComponent } from './activity-status.component';
import { ChildInstancesPanelComponent } from './child-instances-panel.component';
import { TodoListComponent } from './todo-list.component';
import { UserActionRequestComponent } from './user-action-request.component';
import { InstanceHeaderComponent } from './instance-header.component';
import { InstanceWelcomeComponent } from './instance-welcome.component';
import { InstanceReviewPanelComponent } from './instance-review-panel.component';
import { CrossModelReviewPanelComponent } from './cross-model-review-panel.component';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { TodoStore } from '../../core/state/todo.store';
import { RemoteBrowseModalComponent } from '../../shared/components/remote-browse-modal/remote-browse-modal.component';
import { WelcomeCoordinatorService } from './welcome-coordinator.service';
import { FileAttachmentService } from './file-attachment.service';

interface RestartToast {
  id: string;
  type: 'info' | 'error';
  message: string;
}

@Component({
  selector: 'app-instance-detail',
  standalone: true,
  imports: [
    OutputStreamComponent,
    ContextWarningComponent,
    InputPanelComponent,
    DropZoneComponent,
    ActivityStatusComponent,
    ChildInstancesPanelComponent,
    TodoListComponent,
    UserActionRequestComponent,
    InstanceHeaderComponent,
    InstanceWelcomeComponent,
    InstanceReviewPanelComponent,
    CrossModelReviewPanelComponent,
    RemoteBrowseModalComponent
  ],
  template: `
    @if (instance(); as inst) {
      <app-drop-zone
        class="full-drop-zone"
        (filesDropped)="onFilesDropped($event)"
        (imagesPasted)="onImagesPasted($event)"
        (filePathDropped)="onFilePathDropped($event)"
        (filePathsDropped)="onFilePathsDropped($event)"
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
            [currentModel]="inst.currentModel"
            [models]="availableModels()"
            [contextUsage]="inst.contextUsage"
            [canShowFileExplorer]="canShowFileExplorer()"
            [isFileExplorerOpen]="isFileExplorerOpen()"
            (startEditName)="onStartEditName()"
            (cancelEditName)="onCancelEditName()"
            (saveName)="onSaveName($event)"
            (cycleAgentMode)="onCycleAgentMode()"
            (toggleYolo)="onToggleYolo()"
            (selectFolder)="onSelectFolder($event)"
            (interrupt)="onInterrupt()"
            (restart)="onRestart()"
            (restartFresh)="onRestartFresh()"
            (terminate)="onTerminate()"
            (createChild)="onCreateChild()"
            (toggleModelDropdown)="toggleModelDropdown()"
            (closeModelDropdown)="showModelDropdown.set(false)"
            (selectModel)="onChangeModel($event)"
            (toggleFileExplorer)="toggleFileExplorer.emit()"
            (reviewPanelToggle)="toggleCrossModelReviewPanel()"
          />

          <!-- Context warning -->
          @if (contextWarningLevel()) {
            <app-context-warning
              [percentage]="inst.contextUsage.percentage"
              [level]="contextWarningLevel()!"
              [isCompacting]="isCompacting()"
              [dismissed]="contextWarningDismissed()"
              [isEstimated]="inst.contextUsage.isEstimated === true"
              (compactNow)="onCompactNow()"
              (dismiss)="onDismissContextWarning()"
            />
          }

          @if (inst.status === 'error' && inst.recoveryMethod === 'failed') {
            <div class="recovery-banner recovery-banner-error">
              <svg class="recovery-banner-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <div class="recovery-banner-body">
                <span class="recovery-banner-title">Couldn't resume this session</span>
                <span class="recovery-banner-desc">Your transcript is preserved. Start a fresh session to continue.</span>
              </div>
              <div class="recovery-banner-actions">
                <button class="recovery-action recovery-action-primary" (click)="onRestartFresh()">
                  Restart (fresh context)
                </button>
              </div>
            </div>
          }

          <!-- Recovery banner for replay-fallback restores -->
          @if (isReplayFallback() && !recoveryDismissed()) {
            <div class="recovery-banner">
              <svg class="recovery-banner-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <div class="recovery-banner-body">
                <span class="recovery-banner-title">Session context not restored</span>
                <span class="recovery-banner-desc">Your conversation history is shown above, but {{ getProviderDisplayName(inst.provider) }} doesn't have this context. Consider re-summarizing what you were working on.</span>
              </div>
              <div class="recovery-banner-actions">
                <button class="recovery-action recovery-action-primary" (click)="onRecoverySummarize()">Summarize & Continue</button>
                <button class="recovery-action" (click)="onRecoveryDismiss()">Dismiss</button>
              </div>
            </div>
          }

          @if (restartToasts().length > 0) {
            <div class="restart-toast-stack">
              @for (toast of restartToasts(); track toast.id) {
                <div class="restart-toast" [class.restart-toast-error]="toast.type === 'error'">
                  {{ toast.message }}
                </div>
              }
            </div>
          }

          <!-- Output stream (primary content) -->
          <div class="output-section">
            <app-output-stream
              [messages]="inst.outputBuffer"
              [instanceId]="inst.id"
              [provider]="inst.provider"
              [showThinking]="showThinking()"
              [thinkingDefaultExpanded]="thinkingDefaultExpanded()"
              [showToolMessages]="showToolMessages()"
              [isChild]="!!inst.parentId"
              (editMessage)="onEditLastMessage()"
            />
            @if (inst.status === 'busy' || inst.status === 'processing' || inst.status === 'thinking_deeply' || inst.status === 'initializing') {
              <app-activity-status
                [status]="inst.status"
                [activity]="currentActivity()"
                [busySince]="busySince()"
              />
            }
          </div>

          <!-- Cross-model review panel -->
          @if (showCrossModelReviewPanel() && currentReview()) {
            <app-cross-model-review-panel
              [review]="currentReview()"
              (actionPerformed)="onReviewAction($event)"
            />
          }

          <!-- Inspector toggles — only rendered when at least one has content -->
          @if (anyInspectorVisible()) {
            <div class="inspector-toggles-shell">
              <div class="inspector-toggles"
                   role="toolbar"
                   aria-label="Session inspectors">
              @if (todoStore.hasTodos()) {
                <button
                  class="inspector-toggle"
                  [class.active]="showTodoInspector()"
                  [class.entering]="enteringInspectorToggle() === 'todo'"
                  (animationend)="onInspectorToggleAnimationEnd('todo')"
                  (click)="showTodoInspector.set(!showTodoInspector())"
                  [attr.aria-expanded]="showTodoInspector()"
                  title="Toggle task list"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>
                  </svg>
                  Tasks
                  @if (!showTodoInspector()) {
                    <span class="inspector-badge">{{ todoStore.stats().completed }}/{{ todoStore.stats().total }}</span>
                  }
                </button>
              }
              @if (reviewHasContent()) {
                <button
                  class="inspector-toggle"
                  [class.active]="showReviewInspector()"
                  [class.entering]="enteringInspectorToggle() === 'review'"
                  (animationend)="onInspectorToggleAnimationEnd('review')"
                  (click)="showReviewInspector.set(!showReviewInspector())"
                  [attr.aria-expanded]="showReviewInspector()"
                  title="Toggle review panel"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>
                  </svg>
                  Review
                  @if (!showReviewInspector()) {
                    @if (reviewBadgeInfo(); as badge) {
                      <span class="inspector-badge" [class.severity-error]="badge.hasErrors">
                        {{ badge.issueCount }} {{ badge.issueCount === 1 ? 'issue' : 'issues' }}
                      </span>
                    } @else {
                      <span class="inspector-badge running">running</span>
                    }
                  }
                </button>
              }
              @if (hasChildren()) {
                <button
                  class="inspector-toggle"
                  [class.active]="showChildrenInspector()"
                  [class.entering]="enteringInspectorToggle() === 'children'"
                  (animationend)="onInspectorToggleAnimationEnd('children')"
                  (click)="showChildrenInspector.set(!showChildrenInspector())"
                  [attr.aria-expanded]="showChildrenInspector()"
                  title="Toggle child agents"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                  Agents ({{ inst.childrenIds.length }})
                </button>
              }
              <!-- Screen reader announcement for dynamically appearing toggles -->
              <span class="sr-only" aria-live="polite">
                @if (todoStore.hasTodos()) { Task list available. }
                @if (reviewHasContent()) { Review results available. }
              </span>
              </div>
            </div>
          }

          <!-- User action requests + on-demand inspector panels -->
          <app-user-action-request [instanceId]="inst.id" />
          @if (hasActiveInspector()) {
            <div class="inspector-panels">
              @if (showTodoInspector()) {
                <app-todo-list [sessionId]="inst.sessionId" />
              }
              @if (showReviewInspector()) {
                <app-instance-review-panel
                  [instanceId]="inst.id"
                  [workingDirectory]="inst.workingDirectory"
                  (reviewStarted)="onReviewStarted()"
                  (reviewCompleted)="onReviewCompleted($event)"
                />
              }
              @if (showChildrenInspector()) {
                <app-child-instances-panel
                  [childrenIds]="inst.childrenIds"
                  (selectChild)="onSelectChild($event)"
                />
              }
            </div>
          }

          <!-- Input panel (composer) -->
          <app-input-panel
            [instanceId]="inst.id"
            [disabled]="inst.status === 'terminated' || contextWarningLevel() === 'emergency'"
            [placeholder]="inputPlaceholder()"
            [pendingFiles]="pendingFiles()"
            [pendingFolders]="pendingFolders()"
            [queuedCount]="queuedMessageCount()"
            [queuedMessages]="queuedMessages()"
            [isBusy]="inst.status === 'busy'"
            [isRespawning]="inst.status === 'respawning'"
            [outputMessages]="inst.outputBuffer"
            [instanceStatus]="inst.status"
            [provider]="inst.provider"
            [currentModel]="inst.currentModel"
            [isReplayFallback]="isReplayFallback()"
            (sendMessage)="onSendMessage($event)"
            (removeFile)="onRemoveFile($event)"
            (removeFolder)="onRemoveFolder($event)"
            (addFiles)="onAddFiles()"
            (cancelQueuedMessage)="onCancelQueuedMessage($event)"
            (resendEdited)="onResendEdited($event)"
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
        [pendingFolders]="welcomePendingFolders()"
        [projectContext]="welcomeProjectContext()"
        [isProjectContextLoading]="isWelcomeProjectContextLoading()"
        [selectedCli]="welcomeSelectedCli()"
        [initialNodeId]="welcomeSelectedNodeId()"
        (selectFolder)="onSelectWelcomeFolder($event)"
        (sendMessage)="onWelcomeSendMessage($event)"
        (nodeChange)="onWelcomeNodeChange($event)"
        (filesDropped)="onWelcomeFilesDropped($event)"
        (imagesPasted)="onWelcomeImagesPasted($event)"
        (folderDropped)="onWelcomeFolderDropped($event)"
        (filePathDropped)="onWelcomeFilePathDropped($event)"
        (filePathsDropped)="onWelcomeFilePathsDropped($event)"
        (removeFile)="onWelcomeRemoveFile($event)"
        (removeFolder)="onWelcomeRemoveFolder($event)"
        (discardDraft)="onWelcomeDiscardDraft()"
        (addFiles)="onWelcomeAddFiles()"
        (browseRemote)="onWelcomeBrowseRemote($event)"
      />
    }
    <app-remote-browse-modal
      [nodeId]="remoteBrowseNodeId() || ''"
      [isOpen]="remoteBrowseOpen()"
      (folderSelected)="onRemoteFolderSelected($event)"
      (closed)="remoteBrowseOpen.set(false)"
    />
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
        width: 100%;
        min-height: 0;
        overflow: hidden;
        margin: 0;
        padding: 0 16px;
        box-sizing: border-box;
        gap: 10px;
        position: relative;
        z-index: 1;
      }

      /* Recovery banner for replay-fallback restores */
      .recovery-banner {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        flex-shrink: 0;
        padding: 10px 14px;
        background: rgba(245, 158, 11, 0.06);
        border: 1px solid rgba(245, 158, 11, 0.14);
        border-radius: 14px;
        font-size: 12.5px;
        line-height: 1.5;
        color: rgba(245, 158, 11, 0.85);
      }

      .recovery-banner-error {
        background: rgba(var(--error-rgb), 0.08);
        border-color: rgba(var(--error-rgb), 0.18);
        color: rgba(255, 125, 114, 0.92);
      }

      .recovery-banner-error .recovery-action {
        border-color: rgba(var(--error-rgb), 0.24);
        color: rgba(255, 125, 114, 0.92);
      }

      .recovery-banner-error .recovery-action:hover {
        background: rgba(var(--error-rgb), 0.12);
        border-color: rgba(var(--error-rgb), 0.32);
      }

      .recovery-banner-error .recovery-action-primary {
        background: rgba(var(--error-rgb), 0.14);
        border-color: rgba(var(--error-rgb), 0.28);
      }

      .recovery-banner-icon {
        flex-shrink: 0;
        margin-top: 2px;
        opacity: 0.7;
      }

      .recovery-banner-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .recovery-banner-title {
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .recovery-banner-desc {
        font-size: 12px;
        opacity: 0.85;
      }

      .recovery-banner-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
        margin-top: 2px;
      }

      .recovery-action {
        padding: 4px 10px;
        background: transparent;
        border: 1px solid rgba(245, 158, 11, 0.2);
        border-radius: 8px;
        color: rgba(245, 158, 11, 0.85);
        font-size: 11px;
        font-family: var(--font-mono);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: rgba(245, 158, 11, 0.1);
          border-color: rgba(245, 158, 11, 0.3);
        }
      }

      .recovery-action-primary {
        background: rgba(245, 158, 11, 0.12);
        border-color: rgba(245, 158, 11, 0.3);
        font-weight: 600;

        &:hover {
          background: rgba(245, 158, 11, 0.2);
          border-color: rgba(245, 158, 11, 0.4);
        }
      }

      .restart-toast-stack {
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: flex-end;
        flex-shrink: 0;
      }

      .restart-toast {
        max-width: min(100%, 420px);
        padding: 8px 12px;
        border-radius: 12px;
        border: 1px solid rgba(74, 222, 128, 0.18);
        background: rgba(74, 222, 128, 0.08);
        color: #bbf7d0;
        font-family: var(--font-mono);
        font-size: 11px;
        line-height: 1.4;
      }

      .restart-toast-error {
        border-color: rgba(var(--error-rgb), 0.18);
        background: rgba(var(--error-rgb), 0.08);
        color: #fecaca;
      }

      .output-section {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 8px 10px 10px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.015), rgba(255, 255, 255, 0)),
          rgba(8, 12, 11, 0.26);
        border-radius: 22px;
        border: 1px solid rgba(255, 255, 255, 0.04);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.015);
        overflow: hidden;
      }

      .output-section app-output-stream {
        flex: 1;
        min-height: 0;
      }

      .output-section app-activity-status {
        flex-shrink: 0;
        padding: 0 10px 8px;
      }

      .inspector-toggles-shell {
        display: grid;
        grid-template-rows: 1fr;
        overflow: hidden;
        flex-shrink: 0;
      }

      .inspector-toggles {
        display: flex;
        gap: var(--spacing-xs);
        flex-wrap: wrap;
        min-height: 0;
      }

      .inspector-toggle {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 6px 10px;
        background: rgba(255, 255, 255, 0.025);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 999px;
        color: var(--text-muted);
        font-family: var(--font-mono);
        font-size: 9px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          color: var(--text-secondary);
          border-color: rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.04);
        }

        &.active {
          color: var(--primary-color);
          border-color: rgba(var(--primary-rgb), 0.24);
          background: rgba(var(--primary-rgb), 0.1);
        }
      }

      .inspector-badge {
        font-size: 10px;
        font-weight: 700;
        padding: 1px 5px;
        border-radius: 8px;
        background: rgba(var(--primary-rgb), 0.15);
        color: var(--primary-color);
        line-height: 1.2;
      }

      .inspector-panels {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        max-height: 35vh;
        overflow-y: auto;
        flex-shrink: 0;
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.02);
        padding: 8px;
        backdrop-filter: blur(12px);
      }

      /* Entrance animation for the toggle bar */
      @media (prefers-reduced-motion: no-preference) {
        .inspector-toggles-shell {
          animation: inspectorSlideIn 200ms ease-out;
        }

        @keyframes inspectorSlideIn {
          from {
            grid-template-rows: 0fr;
            opacity: 0;
          }
          to {
            grid-template-rows: 1fr;
            opacity: 1;
          }
        }

        .inspector-toggle.entering {
          animation: inspectorPulse 600ms ease-out 1;
        }

        @keyframes inspectorPulse {
          0% {
            border-color: rgba(var(--primary-rgb), 0.12);
            box-shadow: 0 0 0 0 rgba(var(--primary-rgb), 0);
          }
          50% {
            border-color: rgba(var(--primary-rgb), 0.38);
            box-shadow: 0 0 0 6px rgba(var(--primary-rgb), 0.16);
          }
          100% {
            border-color: rgba(255, 255, 255, 0.05);
            box-shadow: 0 0 0 0 rgba(var(--primary-rgb), 0);
          }
        }
      }

      .inspector-badge.severity-error {
        background: rgba(var(--error-rgb), 0.15);
        color: var(--error-color);
      }

      .inspector-badge.running {
        background: rgba(var(--warning-rgb, 251, 191, 36), 0.15);
        color: var(--warning-color, #fbbf24);
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
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

      @media (max-width: 960px) {
        .instance-detail {
          width: 100%;
          padding: 0 10px;
          gap: 8px;
        }

        .output-section {
          padding: 6px 8px 8px;
          border-radius: 18px;
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
  private recentDirsService = inject(RecentDirectoriesIpcService);
  private draftService = inject(DraftService);
  private newSessionDraft = inject(NewSessionDraftService);
  private providerIpc = inject(ProviderIpcService);
  private crossModelReviewService = inject(CrossModelReviewIpcService);
  readonly welcomeCoordinator = inject(WelcomeCoordinatorService);
  private fileAttachment = inject(FileAttachmentService);
  todoStore = inject(TodoStore);
  canShowFileExplorer = input(false);
  isFileExplorerOpen = input(false);
  toggleFileExplorer = output<void>();

  /** Reference to the input panel for triggering edit mode from the output stream. */
  private inputPanel = viewChild(InputPanelComponent);

  instance = this.store.selectedInstance;
  currentActivity = this.store.selectedInstanceActivity;
  busySince = computed(() => this.store.getSelectedInstanceBusySince());
  currentReview = computed(() => {
    const inst = this.instance();
    if (!inst) return null;
    return this.crossModelReviewService.getReviewForInstance(inst.id) ?? null;
  });

  // Inspector panel visibility (F3: on-demand inspectors)
  showTodoInspector = signal(false);
  showReviewInspector = signal(false);
  showChildrenInspector = signal(false);
  showCrossModelReviewPanel = signal(false);
  enteringInspectorToggle = signal<'todo' | 'review' | 'children' | null>(null);

  // Review panel state — driven by output events from InstanceReviewPanelComponent
  reviewHasContent = signal(false);
  reviewBadgeInfo = signal<{ issueCount: number; hasErrors: boolean } | null>(null);

  // Container visibility — only render the toggle bar when at least one toggle has content
  anyInspectorVisible = computed(() =>
    this.todoStore.hasTodos() || this.reviewHasContent() || this.hasChildren()
  );

  // Auto-expand Tasks panel on first appearance (false → true transition).
  // Guard: only fires when the TodoStore's session matches the current instance,
  // preventing stale data from a previous instance from triggering auto-expand
  // during the async gap between setSession() and loadTodos().
  private todoAutoExpandedForInstance = signal<string | null>(null);

  private todoAutoExpandEffect = effect(() => {
    const inst = this.instance();
    const hasTodos = this.todoStore.hasTodos();
    const todoSessionId = this.todoStore.currentSessionId();
    if (!inst) return;

    // Don't auto-expand if todo data is stale (from a previous instance)
    if (todoSessionId !== inst.sessionId) return;

    if (hasTodos && this.todoAutoExpandedForInstance() !== inst.id) {
      this.todoAutoExpandedForInstance.set(inst.id);
      this.showTodoInspector.set(true);
    }
  });

  private inspectorBarWasVisible = false;

  private inspectorToggleEntranceEffect = effect(() => {
    const barVisible = this.anyInspectorVisible();
    const nextEnteringToggle = this.getEnteringInspectorToggle();

    if (!barVisible) {
      this.inspectorBarWasVisible = false;
      this.enteringInspectorToggle.set(null);
      return;
    }

    if (!this.inspectorBarWasVisible) {
      this.enteringInspectorToggle.set(nextEnteringToggle);
    }

    this.inspectorBarWasVisible = true;
  });

  // Keep TodoStore session in sync and reset inspector state on instance change
  private instanceChangeSync = effect(() => {
    const inst = this.instance();
    void this.todoStore.setSession(inst?.sessionId ?? null);

    // Reset inspector panels on instance change
    this.showTodoInspector.set(false);
    this.showReviewInspector.set(false);
    this.showChildrenInspector.set(false);
    this.showCrossModelReviewPanel.set(false);
    this.todoAutoExpandedForInstance.set(null);
    this.reviewHasContent.set(false);
    this.reviewBadgeInfo.set(null);
    this.enteringInspectorToggle.set(null);
    this.inspectorBarWasVisible = false;

    // Reset welcome-screen state so it doesn't bleed across sessions.
    this.welcomeCoordinator.resetState();
  });

  // Computed: any inspector is open
  hasActiveInspector = computed(() =>
    this.showTodoInspector() || this.showReviewInspector() || this.showChildrenInspector()
  );

  // Computed: show children toggle only when instance has children
  hasChildren = computed(() => {
    const inst = this.instance();
    return inst ? inst.childrenIds.length > 0 : false;
  });

  // Settings for display
  showThinking = this.settingsStore.showThinking;
  thinkingDefaultExpanded = this.settingsStore.thinkingDefaultExpanded;
  showToolMessages = this.settingsStore.showToolMessages;

  // Welcome-screen state delegated to WelcomeCoordinatorService
  welcomePendingFiles = this.welcomeCoordinator.pendingFiles;
  welcomePendingFolders = this.welcomeCoordinator.pendingFolders;
  welcomeWorkingDirectory = this.welcomeCoordinator.workingDirectory;
  welcomeSelectedNodeId = this.welcomeCoordinator.welcomeSelectedNodeId;
  remoteBrowseOpen = this.welcomeCoordinator.remoteBrowseOpen;
  remoteBrowseNodeId = this.welcomeCoordinator.remoteBrowseNodeId;
  welcomeSelectedCli = this.welcomeCoordinator.selectedCli;
  isWelcomeProjectContextLoading = this.welcomeCoordinator.isWelcomeProjectContextLoading;
  welcomeProjectContext = this.welcomeCoordinator.projectContext;
  isEditingName = signal(false);
  isCreatingInstance = signal(false);
  isChangingMode = signal(false);
  isTogglingYolo = signal(false);
  showModelDropdown = signal(false);
  availableModels = signal<ModelDisplayInfo[]>([]);
  private manualCompacting = signal(false);
  contextWarningDismissed = signal(false);
  recoveryDismissed = signal(false);
  restartToasts = signal<RestartToast[]>([]);
  private lastDismissedPercentage = 0;
  private lastRecoveryBannerKey: string | null = null;
  private lastRestartToastKey: string | null = null;

  // Replay-fallback detection: instance was restored but CLI context is lost
  isReplayFallback = computed(() => {
    const inst = this.instance();
    return inst?.restoreMode === 'replay-fallback' || inst?.recoveryMethod === 'replay';
  });

  // Merge manual-trigger state with store-tracked auto-compact state
  isCompacting = computed(() => {
    if (this.manualCompacting()) return true;
    const inst = this.instance();
    return inst ? this.store.isInstanceCompacting(inst.id) : false;
  });

  contextWarningLevel = computed(() => {
    const inst = this.instance();
    if (!inst) return null;
    const pct = inst.contextUsage.percentage;
    if (pct >= 95) return 'emergency' as const;
    if (pct >= 80) return 'critical' as const;
    if (pct >= 75) return 'warning' as const;
    return null;
  });

  // Effect to reset dismissal when usage increases >5% since dismissal
  private dismissalResetEffect = effect(() => {
    const inst = this.instance();
    if (!inst) return;
    const pct = inst.contextUsage.percentage;
    if (this.contextWarningDismissed() && pct > this.lastDismissedPercentage + 5) {
      this.contextWarningDismissed.set(false);
    }
  });

  // Track the provider we've fetched models for to avoid redundant fetches
  private lastFetchedProvider: string | null = null;

  // Effect: fetch models dynamically when provider changes
  private modelsFetchEffect = effect(() => {
    const inst = this.instance();
    if (!inst) return;
    const provider = inst.provider;
    if (provider === this.lastFetchedProvider) return;
    this.lastFetchedProvider = provider;
    this.fetchModelsForProvider(provider);
  });

  pendingFiles = computed(() => {
    const inst = this.instance();
    if (!inst) return [];
    this.draftService.attachmentVersion();
    return this.draftService.getPendingFiles(inst.id);
  });

  pendingFolders = computed(() => {
    const inst = this.instance();
    if (!inst) return [];
    this.draftService.attachmentVersion();
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

    // Recovery-aware placeholder for replay-fallback restores
    if (inst.restoreMode === 'replay-fallback' || inst.recoveryMethod === 'replay') {
      return `Summarize what you were working on for ${providerName}...`;
    }

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
      const inst = this.instance();
      const defaultDir = this.settingsStore.defaultWorkingDirectory();
      if (!inst && !this.welcomeWorkingDirectory()) {
        this.newSessionDraft.setWorkingDirectory(defaultDir || null);
      }
    });

    effect(() => {
      const inst = this.instance();
      if (inst) {
        this.isCreatingInstance.set(false);
      }
    });

    effect(() => {
      const inst = this.instance();
      const recoveryKey = inst
        ? `${inst.id}:${inst.restartEpoch}:${inst.restoreMode ?? 'none'}:${inst.recoveryMethod ?? 'none'}`
        : null;
      if (recoveryKey === this.lastRecoveryBannerKey) {
        return;
      }
      this.lastRecoveryBannerKey = recoveryKey;
      this.recoveryDismissed.set(false);
    });

    effect(() => {
      const inst = this.instance();
      if (!inst || !inst.recoveryMethod || inst.restartEpoch <= 0) {
        return;
      }
      if (inst.status === 'initializing' || inst.status === 'respawning') {
        return;
      }

      const toastKey = `${inst.id}:${inst.restartEpoch}:${inst.recoveryMethod}:${inst.status}`;
      if (toastKey === this.lastRestartToastKey) {
        return;
      }

      const message = {
        native: 'Resumed via native session.',
        replay: 'Resumed by replaying the transcript.',
        fresh: 'Started a fresh session. Previous conversation is archived.',
        failed: "Couldn't resume the session. Start a fresh session to continue.",
      }[inst.recoveryMethod];

      if (message) {
        this.showRestartToast(
          message,
          inst.recoveryMethod === 'failed' ? 'error' : 'info'
        );
        this.lastRestartToastKey = toastKey;
      }
    });

    effect(() => {
      const inst = this.instance();
      const workingDirectory = this.welcomeWorkingDirectory();
      if (inst || !workingDirectory) {
        this.welcomeCoordinator.isWelcomeProjectContextLoading.set(false);
        return;
      }

      void this.welcomeCoordinator.loadWelcomeProjectContext(workingDirectory);
    });
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardShortcut(event: KeyboardEvent): void {
    // Escape - interrupt busy or respawning instance
    if (event.key === 'Escape') {
      const inst = this.instance();
      if (inst && (inst.status === 'busy' || inst.status === 'respawning')) {
        event.preventDefault();
        this.onInterrupt();
      }
    }

    // Cmd/Ctrl + O - open folder selection
    if ((event.metaKey || event.ctrlKey) && event.key === 'o') {
      event.preventDefault();
      this.openFolderSelection();
    }

    // Cmd/Ctrl + Shift + V — open review panel
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'V') {
      event.preventDefault();
      this.openReviewPanel();
    }
  }

  /**
   * Open folder selection dialog via keyboard shortcut
   */
  async openFolderSelection(): Promise<void> {
    const folder = await this.recentDirsService.selectFolderAndTrack();
    if (!folder) return;

    const inst = this.instance();
    if (inst) {
      // Update existing instance
      this.store.setWorkingDirectory(inst.id, folder);
    } else {
      // Update welcome screen
      this.newSessionDraft.setWorkingDirectory(folder);
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

  async onChangeModel(modelId: string): Promise<void> {
    this.showModelDropdown.set(false);
    const inst = this.instance();
    if (!inst) return;
    await this.store.changeModel(inst.id, modelId);
  }

  /**
   * Fetch available models for a provider.
   * Dynamically queries the CLI when supported (Copilot), falls back to static lists.
   */
  private async fetchModelsForProvider(provider: string): Promise<void> {
    // Immediately set static fallback for instant display
    const staticModels = PROVIDER_MODEL_LIST[provider] ?? [];
    this.availableModels.set(staticModels);

    // Then try dynamic fetch (may return same static list for non-dynamic providers)
    try {
      const response = await this.providerIpc.listModelsForProvider(provider);
      if (response.success && response.data && response.data.length > 0) {
        this.availableModels.set(response.data);
      }
    } catch {
      // Static fallback already set above
    }
  }

  onReviewAction(event: { reviewId: string; instanceId: string; action: string }): void {
    if (event.action === 'ask-primary') {
      const review = this.currentReview();
      if (!review) return;

      // Filter out reviews where parsing failed — these have meaningless default scores
      const successfulReviews = review.reviews.filter(r => r.parseSuccess);
      if (successfulReviews.length === 0) {
        // All reviews failed to parse — nothing actionable to send
        console.warn('All cross-model reviews failed to parse, skipping feedback injection');
        this.crossModelReviewService.dismiss({ reviewId: event.reviewId, instanceId: event.instanceId });
        return;
      }

      const concerns = successfulReviews
        .flatMap(r => Object.values(r.scores).flatMap(s => s?.issues ?? []))
        .filter(Boolean);

      if (concerns.length > 0) {
        const message = `Cross-model review flagged these issues:\n${concerns.map(c => `- ${c}`).join('\n')}\n\nPlease address them.`;
        this.onSendMessage(message);
      } else {
        // Fallback: issues arrays are empty but scores are low — build message from scores and summaries
        const scoreLines: string[] = [];
        for (const result of successfulReviews) {
          for (const [category, data] of Object.entries(result.scores)) {
            if (data && data.score <= 2) {
              const reasoning = data.reasoning && data.reasoning !== 'No data' && data.reasoning !== 'Unable to parse'
                ? `: ${data.reasoning}` : '';
              scoreLines.push(`- ${category} scored ${data.score}/4${reasoning}`);
            }
          }
        }

        const summaries = successfulReviews
          .map(r => r.summary)
          .filter(s => s && s !== 'Unable to parse reviewer response' && s !== 'Partially parsed response');

        if (scoreLines.length === 0 && summaries.length === 0) {
          // Successfully parsed but nothing actionable — don't inject empty feedback
          this.crossModelReviewService.dismiss({ reviewId: event.reviewId, instanceId: event.instanceId });
          return;
        }

        const parts: string[] = ['Cross-model review flagged concerns with your last response.'];
        if (scoreLines.length > 0) {
          parts.push(`\nLow scores:\n${scoreLines.join('\n')}`);
        }
        if (summaries.length > 0) {
          parts.push(`\nReviewer feedback:\n${summaries.map(s => `> ${s}`).join('\n')}`);
        }
        parts.push('\nPlease review and address these concerns.');

        this.onSendMessage(parts.join('\n'));
      }
    }

    // Always dismiss the review panel after any action
    this.showCrossModelReviewPanel.set(false);
    this.crossModelReviewService.dismiss({ reviewId: event.reviewId, instanceId: event.instanceId });
  }

  onSendMessage(message: string): void {
    const inst = this.instance();
    if (!inst) return;

    const folders = this.pendingFolders();
    const finalMessage = this.fileAttachment.prependPendingFolders(message, folders);

    this.store.sendInput(inst.id, finalMessage, this.pendingFiles());
    this.draftService.clearPendingFiles(inst.id);
    this.draftService.clearPendingFolders(inst.id);
  }

  async onResendEdited(event: { messageIndex: number; text: string }): Promise<void> {
    const inst = this.instance();
    if (!inst) return;

    // Pass the edited text as initialPrompt so the main process delivers it
    // inside the fork's background init (right after CLI spawns). Sending via
    // a separate IPC after fork raced the renderer's status-gated queue: the
    // queue would drain before the new instance reached 'idle', and the
    // message would silently land nowhere.
    const result = await this.ipc.forkSession(
      inst.id,
      event.messageIndex,
      `Edit resend at message ${event.messageIndex}`,
      event.text,
    );

    if (!result?.success || !result.data) return;

    const data = result.data as { id?: string };
    if (!data.id) return;

    // Pre-populate renderer state so 'output' events for the new fork don't
    // arrive before the 'instance:created' event registers the instance.
    this.store.addInstanceFromData(result.data);
    this.store.setSelectedInstance(data.id);
    // Force-terminate (graceful=false): the old instance may be busy mid-response;
    // SIGTERM-with-grace would let it linger and emit confusing output. The new
    // forked instance has the prior conversation, so the old CLI is disposable.
    await this.store.terminateInstance(inst.id, false);
  }

  onEditLastMessage(): void {
    this.inputPanel()?.enterEditMode();
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
    const files = await this.fileAttachment.loadDroppedFilesFromPaths([filePath]);
    if (files.length > 0) {
      this.draftService.addPendingFiles(inst.id, files);
    }
  }

  async onFilePathsDropped(filePaths: string[]): Promise<void> {
    const inst = this.instance();
    if (!inst) return;

    const files = await this.fileAttachment.loadDroppedFilesFromPaths(filePaths);
    if (files.length > 0) {
      this.draftService.addPendingFiles(inst.id, files);
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

  onRestartFresh(): void {
    const inst = this.instance();
    if (inst) {
      this.store.restartFreshInstance(inst.id);
    }
  }

  onSelectFolder(path: string): void {
    const inst = this.instance();
    if (inst && path) {
      this.store.setWorkingDirectory(inst.id, path);
    }
  }

  onStartEditName(): void {
    this.isEditingName.set(true);
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

  private showRestartToast(message: string, type: RestartToast['type']): void {
    const toast: RestartToast = {
      id: `restart-toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type,
      message,
    };

    this.restartToasts.update((current) => [...current, toast]);
    window.setTimeout(() => {
      this.restartToasts.update((current) => current.filter((item) => item.id !== toast.id));
    }, 4000);
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

  async onInterrupt(): Promise<void> {
    const inst = this.instance();
    if (!inst) return;

    if (inst.status === 'busy' || inst.status === 'respawning') {
      const interrupted = await this.store.interruptInstance(inst.id);
      if (!interrupted) {
        // Interrupt was rejected (e.g., status desync between frontend and backend).
        // Force-terminate and restart so the user isn't stuck.
        console.warn('Interrupt rejected, force-terminating and restarting', { instanceId: inst.id, status: inst.status });
        try {
          await this.store.terminateInstance(inst.id);
          await this.store.restartInstance(inst.id);
        } catch (err) {
          console.error('Force-terminate + restart failed after rejected interrupt', err);
        }
      }
    }
  }

  onCreateChild(): void {
    const inst = this.instance();
    if (inst) {
      this.store.createChildInstance(inst.id);
    }
  }

  onWelcomeNodeChange(nodeId: string | null): void {
    this.welcomeCoordinator.onWelcomeNodeChange(nodeId);
  }

  async onWelcomeSendMessage(message: string): Promise<void> {
    await this.welcomeCoordinator.onWelcomeSendMessage(
      message,
      (creating) => this.isCreatingInstance.set(creating),
    );
  }

  onSelectWelcomeFolder(folder: string): void {
    this.welcomeCoordinator.onSelectWelcomeFolder(folder);
  }

  onWelcomeFilesDropped(files: File[]): void {
    this.welcomeCoordinator.onWelcomeFilesDropped(files);
  }

  onWelcomeImagesPasted(images: File[]): void {
    this.welcomeCoordinator.onWelcomeImagesPasted(images);
  }

  onWelcomeRemoveFile(file: File): void {
    this.welcomeCoordinator.onWelcomeRemoveFile(file);
  }

  onWelcomeFolderDropped(folderPath: string): void {
    this.welcomeCoordinator.onWelcomeFolderDropped(folderPath);
  }

  async onWelcomeFilePathDropped(filePath: string): Promise<void> {
    await this.welcomeCoordinator.onWelcomeFilePathDropped(filePath);
  }

  async onWelcomeFilePathsDropped(filePaths: string[]): Promise<void> {
    await this.welcomeCoordinator.onWelcomeFilePathsDropped(filePaths);
  }

  onWelcomeRemoveFolder(folder: string): void {
    this.welcomeCoordinator.onWelcomeRemoveFolder(folder);
  }

  onWelcomeDiscardDraft(): void {
    this.welcomeCoordinator.onWelcomeDiscardDraft();
  }

  onWelcomeBrowseRemote(nodeId: string): void {
    this.welcomeCoordinator.onWelcomeBrowseRemote(nodeId);
  }

  onRemoteFolderSelected(path: string): void {
    this.welcomeCoordinator.onRemoteFolderSelected(path);
  }

  async onAddFiles(): Promise<void> {
    const inst = this.instance();
    if (!inst) return;

    const files = await this.fileAttachment.selectAndLoadFiles(inst.workingDirectory);
    if (files.length > 0) {
      this.draftService.addPendingFiles(inst.id, files);
    }
  }

  async onWelcomeAddFiles(): Promise<void> {
    const files = await this.fileAttachment.selectAndLoadFiles(
      this.welcomeWorkingDirectory(),
    );
    if (files.length > 0) {
      this.newSessionDraft.addPendingFiles(files);
    }
  }

  onSelectChild(childId: string): void {
    this.store.setSelectedInstance(childId);
  }

  onReviewStarted(): void {
    this.reviewHasContent.set(true);
    this.reviewBadgeInfo.set(null);
  }

  onReviewCompleted(result: { issueCount: number; hasErrors: boolean }): void {
    this.reviewHasContent.set(true);
    this.reviewBadgeInfo.set(result);
  }

  private getEnteringInspectorToggle(): 'todo' | 'review' | 'children' | null {
    if (this.todoStore.hasTodos()) {
      return 'todo';
    }
    if (this.reviewHasContent()) {
      return 'review';
    }
    if (this.hasChildren()) {
      return 'children';
    }
    return null;
  }

  openReviewPanel(): void {
    this.showReviewInspector.set(true);
  }

  onInspectorToggleAnimationEnd(toggle: 'todo' | 'review' | 'children'): void {
    if (this.enteringInspectorToggle() === toggle) {
      this.enteringInspectorToggle.set(null);
    }
  }

  toggleCrossModelReviewPanel(): void {
    if (!this.currentReview()) {
      return;
    }
    this.showCrossModelReviewPanel.update(value => !value);
  }

  onCompactNow(): void {
    const inst = this.instance();
    if (inst && !this.isCompacting()) {
      this.manualCompacting.set(true);
      this.store.compactInstance(inst.id).finally(() => {
        this.manualCompacting.set(false);
      });
    }
  }

  onRecoverySummarize(): void {
    const inst = this.instance();
    if (inst) {
      this.draftService.setDraft(inst.id, 'Summarize what we were working on and continue');
      this.recoveryDismissed.set(true);
      this.store.clearInstanceRestoreMode(inst.id);
    }
  }

  onRecoveryDismiss(): void {
    this.recoveryDismissed.set(true);
    const inst = this.instance();
    if (inst) {
      this.store.clearInstanceRestoreMode(inst.id);
    }
  }

  onDismissContextWarning(): void {
    const inst = this.instance();
    if (inst) {
      this.lastDismissedPercentage = inst.contextUsage.percentage;
      this.contextWarningDismissed.set(true);
    }
  }
}
