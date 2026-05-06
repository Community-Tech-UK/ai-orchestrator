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
import { InstanceStore, type InstanceProvider, type OutputMessage } from '../../core/state/instance.store';
import { HistoryStore } from '../../core/state/history.store';
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
import { ChildDiagnosticBundleModalComponent } from '../orchestration/child-diagnostic-bundle.modal.component';
import { TodoListComponent } from './todo-list.component';
import { UserActionRequestComponent } from './user-action-request.component';
import { InstanceHeaderComponent } from './instance-header.component';
import { InstanceWelcomeComponent } from './instance-welcome.component';
import { InstanceReviewPanelComponent } from './instance-review-panel.component';
import { CrossModelReviewPanelComponent } from './cross-model-review-panel.component';
import { ProviderDiagnosticsPanelComponent } from './provider-diagnostics-panel.component';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { OrchestrationHudComponent } from '../orchestration/orchestration-hud.component';
import { QuickActionDispatcherService } from '../orchestration/quick-action-dispatcher.service';
import { TodoStore } from '../../core/state/todo.store';
import { AutomationStore } from '../../core/state/automation.store';
import { RemoteBrowseModalComponent } from '../../shared/components/remote-browse-modal/remote-browse-modal.component';
import { WelcomeCoordinatorService } from './welcome-coordinator.service';
import { FileAttachmentService } from './file-attachment.service';
import type { HudQuickAction } from '../../../../shared/types/orchestration-hud.types';
import {
  getConversationHistoryTitle,
  inferConversationHistoryProvider,
  type ConversationData,
  type ConversationHistoryEntry,
} from '../../../../shared/types/history.types';

interface RestartToast {
  id: string;
  type: 'info' | 'error';
  message: string;
}

interface HistoryPreviewView {
  id: string;
  entry: ConversationHistoryEntry;
  title: string;
  subtitle: string;
  provider: InstanceProvider;
  currentModel?: string;
  messages: OutputMessage[];
  restoring: boolean;
  error: string | null;
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
    ProviderDiagnosticsPanelComponent,
    RemoteBrowseModalComponent,
    OrchestrationHudComponent,
    ChildDiagnosticBundleModalComponent
  ],
  templateUrl: './instance-detail.component.html',
  styleUrl: './instance-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstanceDetailComponent {
  private store = inject(InstanceStore);
  private historyStore = inject(HistoryStore);
  private settingsStore = inject(SettingsStore);
  private ipc = inject(ElectronIpcService);
  private recentDirsService = inject(RecentDirectoriesIpcService);
  private draftService = inject(DraftService);
  private newSessionDraft = inject(NewSessionDraftService);
  private providerIpc = inject(ProviderIpcService);
  private crossModelReviewService = inject(CrossModelReviewIpcService);
  private quickActionDispatcher = inject(QuickActionDispatcherService);
  private automationStore = inject(AutomationStore);
  readonly welcomeCoordinator = inject(WelcomeCoordinatorService);
  private fileAttachment = inject(FileAttachmentService);
  todoStore = inject(TodoStore);
  canShowFileExplorer = input(false);
  isFileExplorerOpen = input(false);
  toggleFileExplorer = output<void>();

  /** Reference to the input panel for triggering edit mode from the output stream. */
  private inputPanel = viewChild(InputPanelComponent);

  instance = this.store.selectedInstance;
  historyPreview = computed<HistoryPreviewView | null>(() => {
    if (this.instance()) {
      return null;
    }

    const conversation = this.historyStore.previewConversation();
    if (!conversation) {
      return null;
    }

    const entry = conversation.entry;
    const provider = inferConversationHistoryProvider(entry) as InstanceProvider;

    return {
      id: this.getHistoryPreviewInstanceId(entry.id),
      entry,
      title: getConversationHistoryTitle(entry),
      subtitle: this.getHistoryPreviewSubtitle(entry, provider),
      provider,
      currentModel: entry.currentModel,
      messages: [
        ...(conversation.messages as OutputMessage[]),
        ...(this.historyPreviewPendingRestoreMessages()[entry.id] ?? []),
      ],
      restoring: this.historyPreviewRestoringEntryId() === entry.id,
      error: this.historyPreviewError(),
    };
  });
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
  private historyPreviewRestorePromise: Promise<string | null> | null = null;
  private historyPreviewRestorePromiseEntryId: string | null = null;
  private historyPreviewRestoringEntryId = signal<string | null>(null);
  private historyPreviewRestoredEntryId: string | null = null;
  private historyPreviewRestoredInstanceId: string | null = null;
  private historyPreviewPendingRestoreMessages = signal<Record<string, OutputMessage[]>>({});
  historyPreviewError = signal<string | null>(null);

  // Recovery detection: instance was restored but provider context is missing or unproven.
  isReplayFallback = computed(() => {
    const inst = this.instance();
    return inst?.restoreMode === 'replay-fallback'
      || inst?.restoreMode === 'resume-unconfirmed'
      || inst?.recoveryMethod === 'replay';
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

  historyPreviewPendingFiles = computed(() => {
    const preview = this.historyPreview();
    if (!preview) return [];
    this.draftService.attachmentVersion();
    return this.draftService.getPendingFiles(preview.id);
  });

  pendingFolders = computed(() => {
    const inst = this.instance();
    if (!inst) return [];
    this.draftService.attachmentVersion();
    return this.draftService.getPendingFolders(inst.id);
  });

  historyPreviewPendingFolders = computed(() => {
    const preview = this.historyPreview();
    if (!preview) return [];
    this.draftService.attachmentVersion();
    return this.draftService.getPendingFolders(preview.id);
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
  threadWakeups = computed(() => {
    const inst = this.instance();
    return inst ? this.automationStore.threadWakeupsForInstance(inst.id) : [];
  });

  inputPlaceholder = computed(() => {
    const inst = this.instance();
    if (!inst) return '';

    const providerName = this.getProviderDisplayName(inst.provider);

    // Recovery-aware placeholder for restores without confirmed provider context.
    if (
      inst.restoreMode === 'replay-fallback'
      || inst.restoreMode === 'resume-unconfirmed'
      || inst.recoveryMethod === 'replay'
    ) {
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
      if (
        inst.status === 'initializing'
        || inst.status === 'respawning'
        || inst.status === 'interrupting'
        || inst.status === 'cancelling'
        || inst.status === 'interrupt-escalating'
      ) {
        return;
      }

      const toastKey = `${inst.id}:${inst.restartEpoch}:${inst.recoveryMethod}:${inst.status}`;
      if (toastKey === this.lastRestartToastKey) {
        return;
      }

      const message = {
        native: 'Confirmed native session resume.',
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
    if (event.defaultPrevented) {
      return;
    }

    // Escape - interrupt busy or respawning instance
    if (event.key === 'Escape') {
      const inst = this.instance();
      if (inst && (
        inst.status === 'busy'
        || inst.status === 'processing'
        || inst.status === 'thinking_deeply'
        || inst.status === 'waiting_for_permission'
        || inst.status === 'respawning'
        || inst.status === 'interrupting'
        || inst.status === 'cancelling'
        || inst.status === 'interrupt-escalating'
      )) {
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

  async onCreateThreadWakeup(event: {
    prompt: string;
    runAt: number;
    intervalMinutes?: number;
    reviveIfArchived: boolean;
  }): Promise<void> {
    const inst = this.instance();
    if (!inst) return;
    await this.automationStore.createThreadWakeup({
      instanceId: inst.id,
      sessionId: inst.providerSessionId,
      historyEntryId: inst.historyThreadId,
      workingDirectory: inst.workingDirectory,
      prompt: event.prompt,
      runAt: event.runAt,
      intervalMinutes: event.intervalMinutes,
      reviveIfArchived: event.reviveIfArchived,
    });
  }

  async onCancelThreadWakeups(): Promise<void> {
    const inst = this.instance();
    if (!inst) return;
    await this.automationStore.cancelThreadWakeups(inst.id);
  }

  showWakeupReviveToggle(status: string): boolean {
    return status === 'failed'
      || status === 'error'
      || status === 'terminated'
      || status === 'cancelled'
      || status === 'superseded'
      || status === 'hibernated';
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
      case 'cursor':
        return 'Cursor';
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

  onHistoryPreviewDraftStarted(): void {
    void this.ensureHistoryPreviewRestored();
  }

  async onHistoryPreviewSendMessage(message: string): Promise<void> {
    const preview = this.historyPreview();
    if (!preview) return;

    const folders = this.historyPreviewPendingFolders();
    const files = this.historyPreviewPendingFiles();
    const finalMessage = this.fileAttachment.prependPendingFolders(message, folders);
    const alreadyRestored = this.historyPreviewRestoredEntryId === preview.entry.id
      && !!this.historyPreviewRestoredInstanceId;
    const pendingSendId = alreadyRestored
      ? null
      : this.addHistoryPreviewPendingRestoreMessage(preview.entry.id, finalMessage);

    try {
      const instanceId = await this.ensureHistoryPreviewRestored();
      if (!instanceId) {
        this.draftService.setDraft(preview.id, message);
        return;
      }

      for (const file of files) {
        this.draftService.removePendingFile(preview.id, file);
      }
      for (const folder of folders) {
        this.draftService.removePendingFolder(preview.id, folder);
      }
      this.draftService.clearPendingFiles(instanceId);
      this.draftService.clearPendingFolders(instanceId);
      this.store.sendInput(instanceId, finalMessage, files);
      this.selectRestoredHistoryPreview(preview.id, instanceId);
    } finally {
      if (pendingSendId) {
        this.removeHistoryPreviewPendingRestoreMessage(preview.entry.id, pendingSendId);
      }
    }
  }

  onSteerMessage(message: string): void {
    const inst = this.instance();
    if (!inst) return;

    const folders = this.pendingFolders();
    const finalMessage = this.fileAttachment.prependPendingFolders(message, folders);

    this.store.steerInput(inst.id, finalMessage, this.pendingFiles());
    this.draftService.clearPendingFiles(inst.id);
    this.draftService.clearPendingFolders(inst.id);
  }

  async onResendEdited(event: {
    messageIndex: number;
    messageId?: string;
    text: string;
    attachments?: { name: string; type: string; size: number; data?: string }[];
    retryMode?: 'transcript-only';
  }): Promise<void> {
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
      `Edit resend at message ${event.messageId ?? event.messageIndex}`,
      event.text,
      {
        atMessageId: event.messageId,
        sourceMessageId: event.messageId,
        attachments: event.attachments,
        preserveRuntimeSettings: true,
        supersedeSource: true,
      },
    );

    if (!result?.success || !result.data) return;

    const data = result.data as { id?: string };
    if (!data.id) return;

    // Pre-populate renderer state so 'output' events for the new fork don't
    // arrive before the 'instance:created' event registers the instance.
    this.store.addInstanceFromData(result.data);
    this.store.setSelectedInstance(data.id);
  }

  onEditLastMessage(): void {
    this.inputPanel()?.enterEditMode();
  }

  onCancelQueuedMessage(index: number): void {
    this.restoreQueuedMessageToComposer(index);
  }

  onEditQueuedMessage(index: number): void {
    this.restoreQueuedMessageToComposer(index);
  }

  private restoreQueuedMessageToComposer(index: number): void {
    const inst = this.instance();
    if (!inst) return;

    const removedMessage = this.store.removeFromQueue(inst.id, index);
    if (removedMessage) {
      const inputPanel = this.inputPanel();
      if (inputPanel) {
        inputPanel.restoreTextToComposer(removedMessage.message);
      } else {
        this.draftService.setDraft(inst.id, removedMessage.message);
      }
      if (removedMessage.files && removedMessage.files.length > 0) {
        this.draftService.addPendingFiles(inst.id, removedMessage.files);
      }
    }
  }

  onSteerQueuedMessage(index: number): void {
    const inst = this.instance();
    if (!inst) return;

    void this.store.steerQueuedMessage(inst.id, index);
  }

  onFilesDropped(files: File[]): void {
    const inst = this.instance();
    if (!inst) return;
    this.draftService.addPendingFiles(inst.id, files);
  }

  onHistoryPreviewFilesDropped(files: File[]): void {
    const preview = this.historyPreview();
    if (!preview) return;
    this.draftService.addPendingFiles(preview.id, files);
  }

  onImagesPasted(images: File[]): void {
    const inst = this.instance();
    if (!inst) return;
    this.draftService.addPendingFiles(inst.id, images);
  }

  onHistoryPreviewImagesPasted(images: File[]): void {
    this.onHistoryPreviewFilesDropped(images);
  }

  onFolderDropped(folderPath: string): void {
    const inst = this.instance();
    if (!inst) return;
    this.draftService.addPendingFolder(inst.id, folderPath);
  }

  onHistoryPreviewFolderDropped(folderPath: string): void {
    const preview = this.historyPreview();
    if (!preview) return;
    this.draftService.addPendingFolder(preview.id, folderPath);
  }

  async onFilePathDropped(filePath: string): Promise<void> {
    const inst = this.instance();
    if (!inst) return;
    const files = await this.fileAttachment.loadDroppedFilesFromPaths([filePath]);
    if (files.length > 0) {
      this.draftService.addPendingFiles(inst.id, files);
    }
  }

  async onHistoryPreviewFilePathDropped(filePath: string): Promise<void> {
    const preview = this.historyPreview();
    if (!preview) return;
    const files = await this.fileAttachment.loadDroppedFilesFromPaths([filePath]);
    if (files.length > 0) {
      this.draftService.addPendingFiles(preview.id, files);
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

  async onHistoryPreviewFilePathsDropped(filePaths: string[]): Promise<void> {
    const preview = this.historyPreview();
    if (!preview) return;

    const files = await this.fileAttachment.loadDroppedFilesFromPaths(filePaths);
    if (files.length > 0) {
      this.draftService.addPendingFiles(preview.id, files);
    }
  }

  onRemoveFile(file: File): void {
    const inst = this.instance();
    if (!inst) return;
    this.draftService.removePendingFile(inst.id, file);
  }

  onRemoveHistoryPreviewFile(file: File): void {
    const preview = this.historyPreview();
    if (!preview) return;
    this.draftService.removePendingFile(preview.id, file);
  }

  onRemoveFolder(folder: string): void {
    const inst = this.instance();
    if (!inst) return;
    this.draftService.removePendingFolder(inst.id, folder);
  }

  onRemoveHistoryPreviewFolder(folder: string): void {
    const preview = this.historyPreview();
    if (!preview) return;
    this.draftService.removePendingFolder(preview.id, folder);
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

    if (
      inst.status === 'busy'
      || inst.status === 'processing'
      || inst.status === 'thinking_deeply'
      || inst.status === 'waiting_for_permission'
      || inst.status === 'respawning'
      || inst.status === 'interrupting'
      || inst.status === 'cancelling'
      || inst.status === 'interrupt-escalating'
    ) {
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

  async onWelcomeStartSessionWithWorkflow(event: {
    message: string;
    templateId: string;
  }): Promise<void> {
    await this.welcomeCoordinator.onWelcomeStartSessionWithWorkflow(
      event.message,
      event.templateId,
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

  async onHistoryPreviewAddFiles(): Promise<void> {
    const preview = this.historyPreview();
    if (!preview) return;

    const files = await this.fileAttachment.selectAndLoadFiles(
      preview.entry.workingDirectory,
    );
    if (files.length > 0) {
      this.draftService.addPendingFiles(preview.id, files);
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

  async onQuickAction(action: HudQuickAction): Promise<void> {
    const result = await this.quickActionDispatcher.dispatch(action);
    if (!result.ok) {
      this.showRestartToast(result.reason ?? 'Quick action failed.', 'error');
    }
  }

  onReviewStarted(): void {
    this.reviewHasContent.set(true);
    this.reviewBadgeInfo.set(null);
  }

  onReviewCompleted(result: { issueCount: number; hasErrors: boolean }): void {
    this.reviewHasContent.set(true);
    this.reviewBadgeInfo.set(result);
  }

  private ensureHistoryPreviewRestored(): Promise<string | null> {
    const conversation = this.historyStore.previewConversation();
    if (!conversation) {
      return Promise.resolve(null);
    }

    const entryId = conversation.entry.id;
    if (
      this.historyPreviewRestoredEntryId === entryId
      && this.historyPreviewRestoredInstanceId
    ) {
      if (this.store.getInstance(this.historyPreviewRestoredInstanceId)) {
        return Promise.resolve(this.historyPreviewRestoredInstanceId);
      }
      this.historyPreviewRestoredEntryId = null;
      this.historyPreviewRestoredInstanceId = null;
    }

    if (
      this.historyPreviewRestorePromise
      && this.historyPreviewRestorePromiseEntryId === entryId
    ) {
      return this.historyPreviewRestorePromise;
    }

    this.historyPreviewError.set(null);
    this.historyPreviewRestoringEntryId.set(entryId);
    const restorePromise = this.restoreHistoryPreview(conversation).finally(() => {
      if (this.historyPreviewRestorePromiseEntryId !== entryId) {
        return;
      }

      this.historyPreviewRestorePromise = null;
      this.historyPreviewRestorePromiseEntryId = null;
      this.historyPreviewRestoringEntryId.set(null);
    });

    this.historyPreviewRestorePromise = restorePromise;
    this.historyPreviewRestorePromiseEntryId = entryId;
    return restorePromise;
  }

  private async restoreHistoryPreview(
    conversation: ConversationData
  ): Promise<string | null> {
    const result = await this.historyStore.restoreEntry(
      conversation.entry.id,
      conversation.entry.workingDirectory
    );

    if (!result.success || !result.instanceId) {
      this.historyPreviewError.set(result.error || 'Failed to restore history entry.');
      return null;
    }

    if (result.restoredMessages && result.restoredMessages.length > 0) {
      this.store.setInstanceMessages(result.instanceId, result.restoredMessages as OutputMessage[]);
    }
    if (result.restoreMode) {
      this.store.setInstanceRestoreMode(result.instanceId, result.restoreMode);
    }

    this.historyPreviewRestoredEntryId = conversation.entry.id;
    this.historyPreviewRestoredInstanceId = result.instanceId;
    return result.instanceId;
  }

  private selectRestoredHistoryPreview(previewId: string, instanceId: string): void {
    const preview = this.historyPreview();
    if (!preview || preview.id !== previewId) {
      return;
    }
    if (
      this.draftService.hasDraft(previewId)
      || this.draftService.hasPendingFiles(previewId)
      || this.draftService.hasPendingFolders(previewId)
    ) {
      return;
    }

    this.historyPreviewRestoredEntryId = null;
    this.historyPreviewRestoredInstanceId = null;
    this.historyStore.clearSelection();
    this.store.setSelectedInstance(instanceId);
  }

  private addHistoryPreviewPendingRestoreMessage(entryId: string, message: string): string {
    const id = `history-preview-queued-${entryId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const timestamp = Date.now();
    const messages: OutputMessage[] = [
      {
        id: `${id}-user`,
        timestamp,
        type: 'user',
        content: message,
        metadata: {
          historyPreviewQueued: true,
        },
      },
      {
        id: `${id}-notice`,
        timestamp: timestamp + 1,
        type: 'system',
        content: 'Restoring this session. Your message will send when the session is ready.',
        metadata: {
          isRestoreNotice: true,
          systemMessageKind: 'history-preview-restore-queue',
        },
      },
    ];

    this.historyPreviewPendingRestoreMessages.update((current) => ({
      ...current,
      [entryId]: [...(current[entryId] ?? []), ...messages],
    }));

    return id;
  }

  private removeHistoryPreviewPendingRestoreMessage(entryId: string, id: string): void {
    this.historyPreviewPendingRestoreMessages.update((current) => {
      const nextMessages = (current[entryId] ?? []).filter(
        (message) => !message.id.startsWith(`${id}-`)
      );

      if (nextMessages.length === 0) {
        const next = { ...current };
        delete next[entryId];
        return next;
      }

      return {
        ...current,
        [entryId]: nextMessages,
      };
    });
  }

  private getHistoryPreviewInstanceId(entryId: string): string {
    return `history-preview:${entryId}`;
  }

  private getHistoryPreviewSubtitle(
    entry: ConversationHistoryEntry,
    provider: InstanceProvider
  ): string {
    const path = entry.workingDirectory.trim() || 'No workspace';
    return `${this.getProviderDisplayName(provider)} history - ${this.shortenPath(path)}`;
  }

  private shortenPath(path: string): string {
    return path
      .replace(/^\/Users\/[^/]+/, '~')
      .replace(/^\/home\/[^/]+/, '~');
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
