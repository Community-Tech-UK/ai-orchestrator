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
  ChangeDetectionStrategy,
  HostListener,
  effect
} from '@angular/core';
import { ContextWarningComponent } from './context-warning.component';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ElectronIpcService, RecentDirectoriesIpcService, VcsIpcService } from '../../core/services/ipc';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { DraftService } from '../../core/services/draft.service';
import { ProviderStateService } from '../../core/services/provider-state.service';
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
import type { RecentDirectoryEntry } from '../../../../shared/types/recent-directories.types';

interface WelcomeProjectContext {
  branch: string | null;
  hasChanges: boolean;
  isRepo: boolean;
  lastAccessed: number | null;
  draftUpdatedAt: number | null;
  hasDraft: boolean;
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
    CrossModelReviewPanelComponent
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
            (terminate)="onTerminate()"
            (createChild)="onCreateChild()"
            (toggleModelDropdown)="toggleModelDropdown()"
            (closeModelDropdown)="showModelDropdown.set(false)"
            (selectModel)="onChangeModel($event)"
            (toggleFileExplorer)="toggleFileExplorer.emit()"
          />

          <!-- Context warning -->
          @if (contextWarningLevel()) {
            <app-context-warning
              [percentage]="inst.contextUsage.percentage"
              [level]="contextWarningLevel()!"
              [isCompacting]="isCompacting()"
              [dismissed]="contextWarningDismissed()"
              (compactNow)="onCompactNow()"
              (dismiss)="onDismissContextWarning()"
            />
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

          <!-- Output stream (primary content) -->
          <div class="output-section" [class.empty-transcript]="inst.outputBuffer.length === 0">
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
                [busySince]="busySince()"
              />
            }
          </div>

          <!-- Cross-model review panel -->
          @if (currentReview()?.hasDisagreement) {
            <app-cross-model-review-panel
              [review]="currentReview()"
              (actionPerformed)="onReviewAction($event)"
            />
          }

          <!-- Inspector toggles -->
          <div class="inspector-toggles">
            <button
              class="inspector-toggle"
              [class.active]="showTodoInspector()"
              (click)="showTodoInspector.set(!showTodoInspector())"
              title="Toggle task list"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>
              </svg>
              Tasks
              @if (todoStore.hasTodos() && !showTodoInspector()) {
                <span class="inspector-badge">{{ todoStore.stats().completed }}/{{ todoStore.stats().total }}</span>
              }
            </button>
            <button
              class="inspector-toggle"
              [class.active]="showReviewInspector()"
              (click)="showReviewInspector.set(!showReviewInspector())"
              title="Toggle review panel"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>
              </svg>
              Review
            </button>
            @if (hasChildren()) {
              <button
                class="inspector-toggle"
                [class.active]="showChildrenInspector()"
                (click)="showChildrenInspector.set(!showChildrenInspector())"
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
          </div>

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
        (selectFolder)="onSelectWelcomeFolder($event)"
        (sendMessage)="onWelcomeSendMessage($event)"
        (filesDropped)="onWelcomeFilesDropped($event)"
        (imagesPasted)="onWelcomeImagesPasted($event)"
        (folderDropped)="onWelcomeFolderDropped($event)"
        (filePathDropped)="onWelcomeFilePathDropped($event)"
        (filePathsDropped)="onWelcomeFilePathsDropped($event)"
        (removeFile)="onWelcomeRemoveFile($event)"
        (removeFolder)="onWelcomeRemoveFolder($event)"
        (discardDraft)="onWelcomeDiscardDraft()"
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

      .output-section.empty-transcript {
        flex: 0 0 240px;
      }

      .output-section app-output-stream {
        flex: 1;
        min-height: 0;
      }

      .output-section app-activity-status {
        flex-shrink: 0;
        padding: 0 10px 8px;
      }

      .inspector-toggles {
        display: flex;
        gap: var(--spacing-xs);
        flex-shrink: 0;
        flex-wrap: wrap;
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
  private vcsIpc = inject(VcsIpcService);
  private draftService = inject(DraftService);
  private providerState = inject(ProviderStateService);
  private newSessionDraft = inject(NewSessionDraftService);
  private providerIpc = inject(ProviderIpcService);
  private crossModelReviewService = inject(CrossModelReviewIpcService);
  todoStore = inject(TodoStore);
  canShowFileExplorer = input(false);
  isFileExplorerOpen = input(false);
  toggleFileExplorer = output<void>();

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

  // Keep TodoStore session in sync with the selected instance (regardless of inspector state)
  private todoSessionSync = effect(() => {
    const inst = this.instance();
    void this.todoStore.setSession(inst?.sessionId ?? null);
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

  // Settings for thinking display
  showThinking = this.settingsStore.showThinking;
  thinkingDefaultExpanded = this.settingsStore.thinkingDefaultExpanded;
  welcomePendingFiles = this.newSessionDraft.pendingFiles;
  welcomePendingFolders = this.newSessionDraft.pendingFolders;
  welcomeWorkingDirectory = this.newSessionDraft.workingDirectory;
  private welcomeProjectSnapshot = signal<{
    branch: string | null;
    hasChanges: boolean;
    isRepo: boolean;
    lastAccessed: number | null;
  } | null>(null);
  isWelcomeProjectContextLoading = signal(false);
  welcomeProjectContext = computed<WelcomeProjectContext | null>(() => {
    const workingDirectory = this.welcomeWorkingDirectory();
    if (!workingDirectory) {
      return null;
    }

    const snapshot = this.welcomeProjectSnapshot();
    return {
      branch: snapshot?.branch ?? null,
      hasChanges: snapshot?.hasChanges ?? false,
      isRepo: snapshot?.isRepo ?? false,
      lastAccessed: snapshot?.lastAccessed ?? null,
      draftUpdatedAt: this.newSessionDraft.updatedAt(),
      hasDraft: this.newSessionDraft.hasActiveContent() || this.welcomePendingFiles().length > 0,
    };
  });
  isEditingName = signal(false);
  isCreatingInstance = signal(false);
  isChangingMode = signal(false);
  isTogglingYolo = signal(false);
  showModelDropdown = signal(false);
  availableModels = signal<ModelDisplayInfo[]>([]);
  private manualCompacting = signal(false);
  contextWarningDismissed = signal(false);
  recoveryDismissed = signal(false);
  private lastDismissedPercentage = 0;

  // Replay-fallback detection: instance was restored but CLI context is lost
  isReplayFallback = computed(() => {
    const inst = this.instance();
    return inst?.restoreMode === 'replay-fallback';
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
  private welcomeContextRequestId = 0;

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

    // Recovery-aware placeholder for replay-fallback restores
    if (inst.restoreMode === 'replay-fallback') {
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
      const workingDirectory = this.welcomeWorkingDirectory();
      if (inst || !workingDirectory) {
        this.welcomeProjectSnapshot.set(null);
        this.isWelcomeProjectContextLoading.set(false);
        return;
      }

      void this.loadWelcomeProjectContext(workingDirectory);
    });
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardShortcut(event: KeyboardEvent): void {
    // Escape - interrupt busy instance
    if (event.key === 'Escape') {
      const inst = this.instance();
      if (inst && inst.status === 'busy') {
        event.preventDefault();
        this.onInterrupt();
      }
    }

    // Cmd/Ctrl + O - open folder selection
    if ((event.metaKey || event.ctrlKey) && event.key === 'o') {
      event.preventDefault();
      this.openFolderSelection();
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
      if (review) {
        const concerns = review.reviews
          .flatMap(r => Object.values(r.scores).flatMap(s => s?.issues ?? []))
          .filter(Boolean);
        if (concerns.length > 0) {
          const message = `Cross-model review flagged these issues:\n${concerns.map(c => `- ${c}`).join('\n')}\n\nPlease address them.`;
          this.onSendMessage(message);
        }
      }
    }
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

  async onFilePathsDropped(filePaths: string[]): Promise<void> {
    const inst = this.instance();
    if (!inst || !window.electronAPI) return;

    const results = await Promise.allSettled(
      filePaths.map(async (filePath) => {
        const stats = await window.electronAPI!.getFileStats(filePath);
        if (!stats.success || !stats.data) return null;
        const data = stats.data as { isDirectory?: boolean };
        if (data.isDirectory) return null;

        const response = await fetch(`file://${filePath}`);
        const blob = await response.blob();
        const fileName = filePath.split('/').pop() || 'file';
        return new File([blob], fileName, {
          type: blob.type || 'application/octet-stream',
        });
      })
    );

    const files = results
      .filter((r): r is PromiseFulfilledResult<File | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter((f): f is File => f !== null);

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

  async onWelcomeSendMessage(message: string): Promise<void> {
    const workingDir = this.welcomeWorkingDirectory() || '.';
    const provider = this.newSessionDraft.provider() ?? this.providerState.getProviderForCreation();
    const model = this.newSessionDraft.model() ?? this.providerState.getModelForCreation();
    const pendingFolders = this.welcomePendingFolders();
    const finalMessage = this.prependPendingFolders(message, pendingFolders);

    this.isCreatingInstance.set(true);
    const launched = await this.store.createInstanceWithMessage(
      finalMessage,
      this.welcomePendingFiles(),
      workingDir,
      provider,
      model
    );

    if (!launched) {
      // Only reset on failure — on success, the effect (which watches
      // instance()) resets isCreatingInstance once the instance:created
      // event arrives.  Resetting eagerly here races with that event and
      // can briefly flash back to the welcome view.
      this.isCreatingInstance.set(false);
      return;
    }

    this.newSessionDraft.clearActiveComposer();
    await this.recentDirsService.addDirectory(workingDir);
  }

  onSelectWelcomeFolder(folder: string): void {
    if (folder) {
      this.newSessionDraft.setWorkingDirectory(folder);
    }
  }

  onWelcomeFilesDropped(files: File[]): void {
    this.newSessionDraft.addPendingFiles(files);
  }

  onWelcomeImagesPasted(images: File[]): void {
    this.newSessionDraft.addPendingFiles(images);
  }

  onWelcomeRemoveFile(file: File): void {
    this.newSessionDraft.removePendingFile(file);
  }

  onWelcomeFolderDropped(folderPath: string): void {
    this.newSessionDraft.addPendingFolder(folderPath);
  }

  async onWelcomeFilePathDropped(filePath: string): Promise<void> {
    const files = await this.loadFilesFromPaths([filePath]);
    if (files.length > 0) {
      this.newSessionDraft.addPendingFiles(files);
    }
  }

  async onWelcomeFilePathsDropped(filePaths: string[]): Promise<void> {
    const files = await this.loadFilesFromPaths(filePaths);
    if (files.length > 0) {
      this.newSessionDraft.addPendingFiles(files);
    }
  }

  onWelcomeRemoveFolder(folder: string): void {
    this.newSessionDraft.removePendingFolder(folder);
  }

  onWelcomeDiscardDraft(): void {
    this.newSessionDraft.clearActiveComposer();
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
      this.newSessionDraft.addPendingFiles(files);
    }
  }

  private async selectAndLoadFiles(): Promise<File[]> {
    const filePaths = await this.ipc.selectFiles({ multiple: true });
    if (!filePaths || filePaths.length === 0) {
      return [];
    }

    return this.loadFilesFromPaths(filePaths);
  }

  private async loadFilesFromPaths(filePaths: string[]): Promise<File[]> {
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

  private prependPendingFolders(message: string, pendingFolders: string[]): string {
    if (pendingFolders.length === 0) {
      return message;
    }

    const folderRefs = pendingFolders.map((folder) => `[Folder: ${folder}]`).join('\n');
    return message ? `${folderRefs}\n\n${message}` : folderRefs;
  }

  private async loadWelcomeProjectContext(workingDirectory: string): Promise<void> {
    const requestId = ++this.welcomeContextRequestId;
    this.isWelcomeProjectContextLoading.set(true);

    try {
      const [recentDirectories, repoResponse] = await Promise.all([
        this.recentDirsService.getDirectories({ sortBy: 'lastAccessed' }),
        this.vcsIpc.vcsIsRepo(workingDirectory),
      ]);

      if (!this.isLatestWelcomeContextRequest(requestId, workingDirectory)) {
        return;
      }

      const recentEntry = this.findRecentDirectoryEntry(recentDirectories, workingDirectory);
      const repoData = (repoResponse.data ?? null) as { isRepo?: boolean } | null;

      if (!repoResponse.success || !repoData?.isRepo) {
        this.welcomeProjectSnapshot.set({
          branch: null,
          hasChanges: false,
          isRepo: false,
          lastAccessed: recentEntry?.lastAccessed ?? null,
        });
        return;
      }

      const statusResponse = await this.vcsIpc.vcsGetStatus(workingDirectory);
      if (!this.isLatestWelcomeContextRequest(requestId, workingDirectory)) {
        return;
      }

      const statusData = (statusResponse.data ?? null) as {
        branch?: string;
        hasChanges?: boolean;
      } | null;

      this.welcomeProjectSnapshot.set({
        branch: statusResponse.success ? statusData?.branch ?? null : null,
        hasChanges: statusResponse.success ? !!statusData?.hasChanges : false,
        isRepo: true,
        lastAccessed: recentEntry?.lastAccessed ?? null,
      });
    } finally {
      if (requestId === this.welcomeContextRequestId) {
        this.isWelcomeProjectContextLoading.set(false);
      }
    }
  }

  private isLatestWelcomeContextRequest(requestId: number, workingDirectory: string): boolean {
    return requestId === this.welcomeContextRequestId &&
      !this.instance() &&
      this.welcomeWorkingDirectory() === workingDirectory;
  }

  private findRecentDirectoryEntry(
    entries: RecentDirectoryEntry[],
    workingDirectory: string
  ): RecentDirectoryEntry | null {
    const normalized = this.normalizePathForComparison(workingDirectory);
    return entries.find((entry) => this.normalizePathForComparison(entry.path) === normalized) ?? null;
  }

  private normalizePathForComparison(path: string | null | undefined): string {
    return (path ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  }

  onSelectChild(childId: string): void {
    this.store.setSelectedInstance(childId);
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
