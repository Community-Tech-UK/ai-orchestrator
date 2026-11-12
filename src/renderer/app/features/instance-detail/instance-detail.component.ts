import { ConfirmService } from '../../shared/confirm/confirm.service';
import { FeatureUsageService } from '../../shared/tips/feature-usage.service';
import { WorkingTipComponent } from '../../shared/tips/working-tip.component';
import { createWorkingTipRuntime, isCompactionPreviewControlAvailable } from '../../shared/tips/working-tip-runtime';
import { LoopOutstandingPanelComponent } from '../loop/loop-outstanding-panel.component';
import { ChildSessionNavComponent } from './child-session-nav.component';
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
  effect,
  untracked
} from '@angular/core';
import { SessionStatusDockComponent } from './session-status-dock.component';
import { buildSecondOpinionFollowUp } from './second-opinion-followup';
import { Router } from '@angular/router';
import { ContextWarningComponent } from './context-warning.component';
import { IdleCacheHintComponent } from './idle-cache-hint.component';
import { RuntimeChangePreviewIpcService } from '../../core/services/ipc/runtime-change-preview-ipc.service';
import type { RuntimeChangeCostNote } from '../../../../shared/utils/runtime-change-cost';
import { RuntimeChangeConfirmComponent } from './runtime-change-confirm.component';
import {
  RuntimeChangePreviewController,
  yoloChangeRequestOf,
  yoloCostKeyOf,
  runtimePreviewIdentityOf,
} from './runtime-change-preview.controller';
import { CompactionPreviewDialogComponent } from './compaction-preview-dialog.component';
import { InstanceStore, type InstanceProvider, type OutputMessage } from '../../core/state/instance.store';
import { typedOrigin } from '../../core/state/instance/instance-messaging-queue-utils';
import { HistoryStore } from '../../core/state/history.store';
import { SettingsStore } from '../../core/state/settings.store';
import { IpcFacadeService, RecentDirectoriesIpcService } from '../../core/services/ipc';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { DraftService } from '../../core/services/draft.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import type { InstanceRuntimeSummary } from '../../../../shared/types/local-model-runtime.types';
import { OutputStreamComponent } from './output-stream.component';
import { InputPanelComponent } from './input-panel.component';
import { appendTextToComposer } from './append-text-to-composer';
import { mergeComposerRestoreText } from './composer-restore-text';
import { ColdCacheResumeService } from './cold-cache-resume.service';
import { DropZoneComponent } from '../file-drop/drop-zone.component';
import { ActivityStatusComponent } from './activity-status.component';
import { ChildDiagnosticBundleModalComponent } from '../orchestration/child-diagnostic-bundle.modal.component';
import { SessionProgressPanelComponent } from './session-progress-panel.component';
import { UserActionRequestComponent } from './user-action-request.component';
import { BrowserApprovalRequestComponent } from './browser-approval-request.component';
import { InstanceHeaderComponent } from './instance-header.component';
import { InstanceWelcomeComponent } from './instance-welcome.component';
import type { NewSessionSubmitRequest } from './input-panel-new-session-submit';
import { CrossModelReviewPanelComponent } from './cross-model-review-panel.component';
import { resolveEscapeRouting } from './session-status-dock.rules';
import { SessionStatusCardComponent } from './session-status-card.component';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { OrchestrationHudComponent } from '../orchestration/orchestration-hud.component';
import { LoopStopConfirmService } from '../loop/loop-stop-confirm.service';
import { LoopControlComponent } from '../loop/loop-control.component';
import { LoopStore } from '../../core/state/loop.store';
import { LoopPromptHistoryService } from '../loop/loop-prompt-history.service';
import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';
import { QuickActionDispatcherService } from '../orchestration/quick-action-dispatcher.service';
import { AutomationStore } from '../../core/state/automation.store';
import { RemoteBrowseModalComponent } from '../../shared/components/remote-browse-modal/remote-browse-modal.component';
import { WelcomeCoordinatorService } from './welcome-coordinator.service';
import { HistoryPreviewSessionService } from './history-preview-session.service';
import { FileAttachmentService } from './file-attachment.service';
import { UnifiedCatalogStore } from '../models/unified-catalog.store';
import type { HudQuickAction } from '../../../../shared/types/orchestration-hud.types';
import { resolveClaudeContextNote, resolveContextWarningLevel } from './context-warning-level';
import {
  getConversationHistoryTitle,
  inferConversationHistoryProvider,
  type ConversationHistoryEntry,
} from '../../../../shared/types/history.types';
import {
  appendHistoryPreviewPendingRestore,
  removeHistoryPreviewPendingRestore,
  getHistoryPreviewInstanceId,
  getHistoryPreviewSubtitle,
  providerDisplayName,
  shouldShowWakeupReviveToggle,
} from './instance-detail-history-preview.utils';

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
  runtimeSummary?: InstanceRuntimeSummary;
  messages: OutputMessage[];
  restoring: boolean;
  error: string | null;
}

/**
 * A loop goal counts as typed by a person only when it came from the message box.
 * With an empty box the goal is the loop panel's prompt, which can be Harness's
 * default or a copy of an earlier run's goal.
 */
function loopGoalTyped(firstMessage: string): { typedByPerson: boolean } {
  return { typedByPerson: firstMessage.trim().length > 0 };
}

interface ResendEditedEvent {
  messageIndex: number;
  messageId?: string;
  text: string;
  attachments?: { name: string; type: string; size: number; data?: string }[];
  retryMode?: 'transcript-only';
}

@Component({
  selector: 'app-instance-detail',
  standalone: true,
  imports: [
    IdleCacheHintComponent,
    OutputStreamComponent,
    ContextWarningComponent,
    CompactionPreviewDialogComponent,
    InputPanelComponent,
    DropZoneComponent,
    ActivityStatusComponent,
    WorkingTipComponent,
    ChildSessionNavComponent,
    SessionProgressPanelComponent,
    UserActionRequestComponent,
    BrowserApprovalRequestComponent,
    InstanceHeaderComponent,
    RuntimeChangeConfirmComponent,
    InstanceWelcomeComponent,
    CrossModelReviewPanelComponent,
    RemoteBrowseModalComponent,
    OrchestrationHudComponent,
    ChildDiagnosticBundleModalComponent,
    LoopControlComponent,
    LoopOutstandingPanelComponent,
    SessionStatusDockComponent,
    SessionStatusCardComponent
  ],
  templateUrl: './instance-detail.component.html',
  styleUrl: './instance-detail.component.scss',
  providers: [RuntimeChangePreviewController],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstanceDetailComponent {
  private readonly featureUsage = inject(FeatureUsageService);
  private readonly confirmService = inject(ConfirmService);
  private router = inject(Router);
  /** Says what a model or auto-approve change will cost before it is made, and holds a large one for a yes (T17). */
  protected readonly runtimeChange = inject(RuntimeChangePreviewController);
  private store = inject(InstanceStore);
  private historyStore = inject(HistoryStore);
  private historySessions = inject(HistoryPreviewSessionService);
  private settingsStore = inject(SettingsStore);
  private ipc = inject(IpcFacadeService);
  private recentDirsService = inject(RecentDirectoriesIpcService);
  private draftService = inject(DraftService);
  private newSessionDraft = inject(NewSessionDraftService);
  private providerIpc = inject(ProviderIpcService);
  private crossModelReviewService = inject(CrossModelReviewIpcService);
  private quickActionDispatcher = inject(QuickActionDispatcherService);
  private loopStopConfirm = inject(LoopStopConfirmService);
  private loopStore = inject(LoopStore);
  private loopPromptHistory = inject(LoopPromptHistoryService);
  private automationStore = inject(AutomationStore);
  readonly welcomeCoordinator = inject(WelcomeCoordinatorService);
  private fileAttachment = inject(FileAttachmentService);
  private unifiedCatalog = inject(UnifiedCatalogStore);
  canShowFileExplorer = input(false);
  isFileExplorerOpen = input(false);
  toggleFileExplorer = output<void>();
  canShowSourceControl = input(false);
  isSourceControlOpen = input(false);
  sourceControlChangeCount = input(0);
  toggleSourceControl = output<void>();

  /** Reference to the input panel for triggering edit mode from the output stream. */
  private inputPanel = viewChild(InputPanelComponent);
  /** Status dock (the optional-chip strip) for Esc routing and Cmd+Shift+V. */
  private statusDock = viewChild(SessionStatusDockComponent);
  readonly appendTextToComposer = (text: string): void => appendTextToComposer(this.inputPanel(), text);
  /** The compact-preview tip is offered only while its real control — the context warning's Preview / Compact Now actions — is on screen. */
  readonly compactPreviewControlAvailable = computed(() =>
    isCompactionPreviewControlAvailable(this.contextWarningLevel(), this.contextWarningDismissed(), this.isCompacting()));
  readonly workingTipContext = createWorkingTipRuntime(this.store, this.settingsStore, this.loopStore,
    () => this.inputPanel(), () => this.compactPreviewControlAvailable());
  private readonly coldCache = inject(ColdCacheResumeService);

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
      id: getHistoryPreviewInstanceId(entry.id),
      entry,
      title: getConversationHistoryTitle(entry),
      subtitle: getHistoryPreviewSubtitle(entry, provider),
      provider,
      currentModel: entry.currentModel,
      runtimeSummary: entry.runtimeSummary,
      messages: [
        ...(conversation.messages as OutputMessage[]),
        ...(this.historyPreviewPendingRestoreMessages()[entry.id] ?? []),
      ],
      restoring: this.historySessions.isRestoring(entry.id),
      error: this.historyPreviewError(),
    };
  });
  /** Keep continuation defaults aligned with the pick without rewriting history metadata. */
  readonly historyPreviewComposerProvider = computed<InstanceProvider>(() => {
    const preview = this.historyPreview();
    const pending = preview ? this.historySessions.selection(preview.entry.id) : null;
    return pending && pending.provider !== 'local-model'
      ? pending.provider
      : preview?.provider ?? 'claude';
  });
  readonly historyPreviewOlderMessagesProbe = async (): Promise<{
    hasMore: boolean;
    totalStored: number;
  }> => ({
    hasMore: false,
    totalStored: this.historyPreview()?.messages.length ?? 0,
  });
  readonly pasteDraftOwner = (): string => {
    const instance = this.instance();
    if (instance) return `instance:${instance.id}`;
    const preview = this.historyPreview();
    return preview ? `history:${preview.id}` : `new:${this.newSessionDraft.activeKey()}`;
  };
  currentActivity = this.store.selectedInstanceActivity;
  busySince = computed(() => this.store.getSelectedInstanceBusySince());
  currentReview = computed(() => {
    const inst = this.instance();
    if (!inst) return null;
    return this.crossModelReviewService.getReviewForInstance(inst.id) ?? null;
  });

  // Cross-model review panel visibility (the strip's chips live in SessionStatusDockComponent)
  showCrossModelReviewPanel = signal(false);

  // Reset view state on instance or provider-session change
  private instanceChangeSync = effect(() => {
    // Do not subscribe to the full instance snapshot here. Streaming output
    // and status events replace that object many times per second; treating
    // each replacement as a session switch reset every panel and retried
    // its IPC loads, which made the active conversation visibly flicker.
    // These primitive selectors update only for a real visible-instance or
    // provider-session change (including a fresh restart of the same instance).
    void this.store.selectedInstanceIdentity();
    void this.store.selectedInstanceSessionId();

    this.showCrossModelReviewPanel.set(false);

    // Reset welcome-screen state so it doesn't bleed across sessions.
    this.welcomeCoordinator.resetState();
  });

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
  welcomeModelRuntimeTarget = this.welcomeCoordinator.modelRuntimeTarget;
  remoteBrowseOpen = this.welcomeCoordinator.remoteBrowseOpen;
  remoteBrowseNodeId = this.welcomeCoordinator.remoteBrowseNodeId;
  welcomeSelectedCli = this.welcomeCoordinator.selectedCli;
  isWelcomeProjectContextLoading = this.welcomeCoordinator.isWelcomeProjectContextLoading;
  welcomeProjectContext = this.welcomeCoordinator.projectContext;
  isEditingName = signal(false);
  isCreatingInstance = signal(false);
  isChangingMode = signal(false);
  isTogglingYolo = signal(false);
  isTogglingFastMode = signal(false);
  private manualCompacting = signal(false);
  /** WS-B7: manual-compaction preview dialog open state. */
  compactionPreviewOpen = signal(false);
  contextWarningDismissed = signal(false);
  recoveryDismissed = signal(false);
  restartToasts = signal<RestartToast[]>([]);
  private lastDismissedPercentage = 0;
  private lastRecoveryBannerKey: string | null = null;
  private lastRestartToastKey: string | null = null;
  private historyPreviewPendingRestoreMessages = signal<Record<string, OutputMessage[]>>({});
  historyPreviewError = computed(() => {
    const entryId = this.historyStore.previewConversation()?.entry.id;
    return entryId ? this.historySessions.error(entryId) : null;
  });

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

  /** Rules and rationale live in `resolveContextWarningLevel` (LT-018/LT-034). */
  contextWarningLevel = computed(() => {
    const inst = this.instance();
    if (!inst) return null;
    return resolveContextWarningLevel(inst.contextUsage, inst.selfManagesAutoCompaction);
  });

  private readonly runtimePreview = inject(RuntimeChangePreviewIpcService);
  private readonly runtimeChangeKey = computed(() => {
    const inst = this.instance();
    return JSON.stringify([inst?.id, runtimePreviewIdentityOf(inst), inst?.provider, inst?.currentModel,
      inst?.reasoningEffort, inst?.accountProfileId, inst?.copilotAccountProfileId, inst?.runtimeSummary, inst?.desiredRuntime, inst?.yoloMode]);
  });
  private runtimeChangeBinding = effect(() => this.runtimeChange.bind(this.runtimeChangeKey()));
  /** What flipping auto-approve would cost, from the main process; empty for almost every session (T17). */
  private readonly yoloCost = signal<RuntimeChangeCostNote | null>(null);
  readonly yoloCostNote = computed(() => this.yoloCost()?.text ?? null);
  private readonly yoloCostKey = computed(() => yoloCostKeyOf(this.instance()));
  private yoloCostEffect = effect(onCleanup => {
    let active = true;
    onCleanup(() => { active = false; });
    this.yoloCost.set(null);
    if (!this.yoloCostKey()) return;
    const inst = untracked(() => this.instance());
    if (!inst) return;
    void this.runtimePreview
      .preview(inst.id, yoloChangeRequestOf(inst, !(inst.pendingYoloMode ?? inst.yoloMode)))
      .then((note) => { if (active) this.yoloCost.set(note); });
  });

  readonly claudeContextNote = computed(() => {
    const inst = this.instance();
    if (!inst) return null;
    const settings = this.settingsStore.settings();
    return resolveClaudeContextNote(inst, {
      machineContextCeilingTokens: settings.machineContextCeilingTokens,
      ownChatContextCeilingTokens: settings.ownChatContextCeilingTokens,
    });
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

    const providerName = this.getProviderDisplayName(inst.provider, inst.currentModel);

    // Recovery-aware placeholder for restores without confirmed provider context.
    if (
      inst.restoreMode === 'replay-fallback'
      || inst.restoreMode === 'resume-unconfirmed'
      || inst.recoveryMethod === 'replay'
    ) {
      return `Continue with condensed context for ${providerName}...`;
    }

    switch (inst.status) {
      case 'waiting_for_input':
        return `${providerName} is waiting for your response...`;
      case 'busy':
        return 'Processing...';
      case 'terminated':
        return `Type to restart ${providerName} and continue...`;
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

    // Escape - dismiss an open status-dock surface (chip panel or overflow row) first, else interrupt an in-flight turn
    if (event.key === 'Escape') {
      const inst = this.instance();
      const routing = resolveEscapeRouting({
        dockPanelWasOpen: this.statusDock()?.dismissOpenSurface() ?? false,
        instanceStatus: inst?.status,
      });
      if (routing === 'chip-panel') {
        event.preventDefault();
        return;
      }
      if (routing === 'interrupt' && inst) {
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
    return shouldShowWakeupReviveToggle(status);
  }

  getProviderDisplayName(provider: string, model?: string | null): string {
    return providerDisplayName(provider, model);
  }

  /**
   * Refresh dynamic model catalogs when the provider changes. The unified
   * catalog feeds the compact picker; renderer-side discovery remains a
   * producer for providers that still need it (Copilot, Cursor).
   */
  private async fetchModelsForProvider(provider: string): Promise<void> {
    this.unifiedCatalog.ensureLoaded();

    if (provider === 'copilot' || provider === 'cursor') {
      try {
        const response = await this.providerIpc.listModelsForProvider(provider);
        if (response.success && response.data && response.data.length > 0) {
          void this.providerIpc.pushCliDiscoveredModels(provider, response.data);
        }
      } catch {
        // Catalog keeps its static/unified entries.
      }
    }
  }

  onReviewAction(event: { reviewId: string; instanceId: string; action: string }): void {
    if (event.action === 'ask-primary') {
      const review = this.currentReview();
      if (!review) return;

      const message = buildSecondOpinionFollowUp(review);
      if (message) this.sendFromApp(message);
    }

    // Always dismiss the review panel after any action
    this.showCrossModelReviewPanel.set(false);
    this.crossModelReviewService.dismiss({ reviewId: event.reviewId, instanceId: event.instanceId });
  }

  /** Text the app built from reviewers' findings. It is not James's words, so it is never marked as typed by a person, even though he clicked to send it. */
  private sendFromApp(message: string): void {
    const inst = this.instance();
    if (!inst) return;

    const folders = this.pendingFolders();
    const finalMessage = this.fileAttachment.prependPendingFolders(message, folders);

    this.store.sendInput(inst.id, finalMessage, this.pendingFiles());
    this.draftService.clearPendingFiles(inst.id);
    this.draftService.clearPendingFolders(inst.id);
  }

  /**
   * The message box (typed or spoken), the only send that is James's own words, so it is marked as typed by a
   * person. It also uses the optional cold-return summary.
   */
  onComposerSend(message: string): void {
    const inst = this.instance();
    if (!inst) return;
    const files = [...this.pendingFiles()];
    const folders = [...this.pendingFolders()];
    const finalMessage = this.fileAttachment.prependPendingFolders(message, folders);
    void this.coldCache.compactThenSend(inst.id, message, () => {
      void this.store.sendInput(inst.id, finalMessage, files, { typedByPerson: true });
      for (const file of files) this.draftService.removePendingFile(inst.id, file);
      for (const folder of folders) this.draftService.removePendingFolder(inst.id, folder);
    }, text => {
      const existing = this.draftService.getDraft(inst.id);
      const restored = existing ? `${text}\n${existing}` : text;
      if (this.instance()?.id === inst.id) this.inputPanel()?.restoreTextToComposer(restored);
      else this.draftService.setDraft(inst.id, restored);
    });
  }

  onHistoryPreviewDraftStarted(): void {
    void this.ensureHistoryPreviewRestored(false);
  }

  async onHistoryPreviewSendMessage(message: string): Promise<void> {
    const preview = this.historyPreview();
    if (!preview) return;

    const folders = this.historyPreviewPendingFolders();
    const files = this.historyPreviewPendingFiles();
    const finalMessage = this.fileAttachment.prependPendingFolders(message, folders);
    const alreadyRestored = !!this.historySessions.restoredInstanceId(preview.entry.id);
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
      this.store.sendInput(instanceId, finalMessage, files, { typedByPerson: true });
      this.selectRestoredHistoryPreview(preview.id, instanceId);
    } finally {
      if (pendingSendId) {
        this.removeHistoryPreviewPendingRestoreMessage(preview.entry.id, pendingSendId);
      }
    }
  }

  async onHistoryPreviewLoopStartRequested(payload: {
    config: LoopStartConfigInput;
    firstMessage: string;
    attachments: { name: string; data: Uint8Array }[];
    onResolved: (ok: boolean, error?: string) => void;
  }): Promise<void> {
    const preview = this.historyPreview();
    if (!preview) {
      payload.onResolved(false, 'No history preview selected.');
      return;
    }

    const submittedSelection = this.historySessions.selection(preview.entry.id);
    const submittedAccount = this.historySessions.accountChoice(preview.entry.id);
    try {
      const instanceId = await this.ensureHistoryPreviewRestored();
      if (!instanceId) {
        payload.onResolved(false, this.historySessions.error(preview.entry.id) || 'Could not restore history entry for loop.');
        return;
      }

      // The loop config was captured on submission, while prepare intentionally
      // applies the latest choice. Do not launch an older provider configuration
      // if the user changed that choice during restore; preserve the form for retry.
      if (this.historySessions.accountChoice(preview.entry.id) !== submittedAccount) {
        const message = 'The account choice changed while restoring. Start the loop again to use the latest choice.';
        this.historySessions.setError(preview.entry.id, message);
        payload.onResolved(false, message);
        return;
      }
      if (this.historySessions.selection(preview.entry.id) !== submittedSelection) {
        const message = 'The model choice changed while restoring. Start the loop again to use the latest choice.';
        this.historySessions.setError(preview.entry.id, message);
        payload.onResolved(false, message);
        return;
      }

      const r = await this.loopStore.start(instanceId, payload.config, payload.attachments, loopGoalTyped(payload.firstMessage));
      if (!r.ok) {
        const msg = r.error ?? 'unknown error';
        // WS8: plan-scope refusals route to the Campaign import flow.
        if (r.errorCode?.startsWith('LOOP_SCOPE_CAMPAIGN')) {
          void this.router.navigate(['/campaigns'], {
            queryParams: {
              planFile: payload.config.planFile ?? '',
              workspaceCwd: payload.config.workspaceCwd,
              verifyCommand: payload.config.completion?.verifyCommand ?? '',
            },
          });
        }
        this.historySessions.setError(preview.entry.id, `Loop start failed: ${msg}`);
        payload.onResolved(false, msg);
        return;
      }

      this.loopPromptHistory.remember(payload.config.iterationPrompt ?? payload.config.initialPrompt);
      this.draftService.clearDraft(preview.id);
      this.draftService.clearPendingFiles(preview.id);
      this.draftService.clearPendingFolders(preview.id);
      payload.onResolved(true);
      this.selectRestoredHistoryPreview(preview.id, instanceId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.historySessions.setError(preview.entry.id, `Loop start failed: ${msg}`);
      payload.onResolved(false, msg);
    }
  }

  onSteerMessage(message: string): void {
    const inst = this.instance();
    if (!inst) return;

    const folders = this.pendingFolders();
    const finalMessage = this.fileAttachment.prependPendingFolders(message, folders);

    this.store.steerInput(inst.id, finalMessage, this.pendingFiles());
    this.featureUsage.record('steer');
    this.draftService.clearPendingFiles(inst.id);
    this.draftService.clearPendingFolders(inst.id);
  }

  async onResendEdited(event: ResendEditedEvent): Promise<void> {
    const inst = this.instance();
    if (inst) {
      await this.forkEditedResend(inst.id, event);
      return;
    }

    const preview = this.historyPreview();
    if (!preview) return;

    const restoredInstanceId = await this.ensureHistoryPreviewRestored();
    if (!restoredInstanceId) {
      return;
    }

    const forkedInstanceId = await this.forkEditedResend(restoredInstanceId, event);
    if (!forkedInstanceId) {
      return;
    }

    this.historySessions.complete(preview.entry.id);
    this.historyStore.clearSelection();
  }

  private async forkEditedResend(
    instanceId: string,
    event: ResendEditedEvent,
  ): Promise<string | null> {
    // Pass the edited text as initialPrompt so the main process delivers it
    // inside the fork's background init (right after CLI spawns). Sending via
    // a separate IPC after fork raced the renderer's status-gated queue: the
    // queue would drain before the new instance reached 'idle', and the
    // message would silently land nowhere. Main keeps the typed mark only when the
    // message being edited was itself typed by a person.
    const result = await this.ipc.forkSession(
      instanceId,
      event.messageIndex,
      `Edit resend at message ${event.messageId ?? event.messageIndex}`,
      event.text,
      {
        atMessageId: event.messageId,
        sourceMessageId: event.messageId,
        attachments: event.attachments,
        preserveRuntimeSettings: true,
        supersedeSource: true,
        initialPromptOrigin: typedOrigin(true),
      },
    );

    if (!result?.success || !result.data) return null;

    const data = result.data as { id?: string };
    if (!data.id) return null;

    // Pre-populate renderer state so 'output' events for the new fork don't
    // arrive before the 'instance:created' event registers the instance.
    this.store.addInstanceFromData(result.data);
    this.store.setSelectedInstance(data.id);
    return data.id;
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

    const removedMessage = this.store.cancelQueuedMessage(inst.id, index);
    if (removedMessage) {
      const inputPanel = this.inputPanel();
      if (inputPanel) {
        inputPanel.restoreTextToComposer(removedMessage.message);
      } else {
        this.draftService.setDraft(inst.id, mergeComposerRestoreText(removedMessage.message, this.draftService.getDraft(inst.id)));
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
    this.featureUsage.record('steer');
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

  // Note: restart / terminate / create-child have moved to the session
  // right-click menu in the instance list, which calls the store directly.
  // `onRestartFresh` is kept because the recovery banner below the header
  // calls it from a dedicated "Restart (fresh context)" button.
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

    // Queue-aware: the state a click flips is the parked value if one is
    // pending, otherwise the live mode. A click while busy is no longer
    // swallowed — it queues and auto-applies when the turn finishes.
    const effectiveTarget = inst.pendingYoloMode ?? inst.yoloMode;
    const willEnable = !effectiveTarget;
    if (willEnable) {
      const confirmed = await this.confirmService.confirm({ message: 'Enable Auto-approve? Runs tools and edits without asking you.' +
          (this.yoloCostNote() ? `\n\n${this.yoloCostNote()}` : '') +
          (inst.status === 'busy'
            ? '\n\nThe session is busy — Auto-approve will turn on automatically once the current turn finishes.'
            : ''), confirmLabel: 'Enable Auto-approve', danger: true });
      if (!confirmed) return;
    }

    if (this.isTogglingYolo()) return;

    if (willEnable) {
      await this.flipYolo(inst.id);
      return;
    }
    // Turning it off asks too when the restart would leave a large conversation behind; turning it on was
    // just confirmed above, with the same sentence in the question.
    await this.runtimeChange.gate(inst.id, yoloChangeRequestOf(inst, false), () => this.flipYolo(inst.id),
      { confirm: 'Turn auto-approve off anyway', cancel: 'Keep auto-approve on' });
  }

  private async flipYolo(instanceId: string): Promise<void> {
    if (this.isTogglingYolo()) return;
    this.isTogglingYolo.set(true);
    try {
      await this.store.toggleYoloMode(instanceId);
    } finally {
      this.isTogglingYolo.set(false);
    }
  }

  async onToggleFastMode(): Promise<void> {
    const inst = this.instance();
    if (!inst) return;
    if (inst.status === 'busy') return;
    if (this.isTogglingFastMode()) return;

    this.isTogglingFastMode.set(true);
    try {
      await this.store.toggleFastMode(inst.id);
    } finally {
      this.isTogglingFastMode.set(false);
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
      // B7: park BEFORE the interrupt. The interrupt drives the session back to
      // `idle`, and both drain triggers treat `idle` as "go" — parking after
      // the await would lose the race with the queue it is meant to hold.
      this.store.parkQueueAfterInterrupt(inst.id);
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

  onWelcomeNodeChange(nodeId: string | null): void {
    this.welcomeCoordinator.onWelcomeNodeChange(nodeId);
  }

  /**
   * Acknowledgement-driven new-session launch. `onResolved` must be called on
   * every path — the composer is still holding the user's text and attachments
   * until it is, which is the whole point of the contract.
   */
  async onWelcomeSubmit(request: NewSessionSubmitRequest): Promise<void> {
    // If the composer stops waiting, drop the "Starting conversation…" view —
    // it replaces the welcome screen, so leaving it up would hide the recovery
    // banner behind a spinner that never goes away.
    request.onTimeout(() => this.isCreatingInstance.set(false));
    try {
      const result = await this.welcomeCoordinator.submitWelcomeMessage(
        request.text,
        (creating) => this.isCreatingInstance.set(creating),
        request.submissionId,
        { files: request.files, pendingFolders: request.pendingFolders },
      );
      // Only a confirmed success keeps the "Starting conversation…" view up —
      // an effect swaps it out once the instance lands. Any other outcome must
      // put the composer back so the retained composition is reachable.
      if (!result.ok) {
        this.isCreatingInstance.set(false);
      }
      request.onResolved(result);
    } catch (error) {
      this.isCreatingInstance.set(false);
      request.onResolved({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async onLoopStartRequested(payload: {
    config: LoopStartConfigInput;
    firstMessage: string;
    attachments: { name: string; data: Uint8Array }[];
    onResolved: (ok: boolean, error?: string) => void;
  }): Promise<void> {
    const { config, firstMessage, attachments, onResolved } = payload;
    try {
      // The loop directive (panel prompt) is what's reusable across sessions —
      // remember that, not the goal-specific textarea content.
      const directiveForHistory = config.iterationPrompt ?? config.initialPrompt;
      const inst = this.store.selectedInstance();
      if (inst) {
        const r = await this.loopStore.start(inst.id, config, attachments, loopGoalTyped(firstMessage));
        if (r.ok) {
          this.loopPromptHistory.remember(directiveForHistory);
          onResolved(true);
        } else {
          const msg = r.error ?? 'unknown error';
          this.store.setError(`Loop start failed: ${msg}`);
          onResolved(false, msg);
        }
        return;
      }
      let lastStartError: string | undefined;
      const ok = await this.welcomeCoordinator.onWelcomeStartSessionWithLoop(
        firstMessage,
        config,
        (creating) => this.isCreatingInstance.set(creating),
        async (newChatId, loopConfig) => {
          const r = await this.loopStore.start(newChatId, loopConfig, attachments, loopGoalTyped(firstMessage));
          if (!r.ok) lastStartError = r.error;
          return r;
        },
      );
      if (ok) {
        this.loopPromptHistory.remember(directiveForHistory);
        onResolved(true);
      } else {
        onResolved(false, lastStartError ?? 'Could not create session for loop.');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.store.setError(`Loop start failed: ${msg}`);
      onResolved(false, msg);
    }
  }

  async onLoopStopRequested(): Promise<void> {
    const inst = this.store.selectedInstance();
    if (!inst) return;
    const a = this.loopStore.activeForChat(inst.id)();
    if (a) this.loopStopConfirm.request(a.id, a.config.isolateLoopWorkspaces === true, { chatId: a.chatId });
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

  private ensureHistoryPreviewRestored(applySelection = true): Promise<string | null> {
    const conversation = this.historyStore.previewConversation();
    if (!conversation) return Promise.resolve(null);
    return applySelection
      ? this.historySessions.prepare(conversation)
      : this.historySessions.restore(conversation);
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

    this.historySessions.complete(preview.entry.id);
    this.historyStore.clearSelection();
    this.store.setSelectedInstance(instanceId);
  }

  private addHistoryPreviewPendingRestoreMessage(entryId: string, message: string): string {
    const { id, next } = appendHistoryPreviewPendingRestore(
      this.historyPreviewPendingRestoreMessages(),
      entryId,
      message,
    );
    this.historyPreviewPendingRestoreMessages.set(next);
    return id;
  }

  private removeHistoryPreviewPendingRestoreMessage(entryId: string, id: string): void {
    this.historyPreviewPendingRestoreMessages.update((current) =>
      removeHistoryPreviewPendingRestore(current, entryId, id),
    );
  }

  openReviewPanel(): void {
    this.statusDock()?.openReviewPanel();
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

  /** WS-B7: opens the manual-compaction preview dialog instead of compacting immediately. */
  onPreviewCompaction(): void {
    if (this.instance() && !this.isCompacting()) {
      this.compactionPreviewOpen.set(true);
      this.featureUsage.record('compact-preview');
    }
  }

  onRecoverySummarize(): void {
    const inst = this.instance();
    if (inst) {
      this.draftService.setDraft(inst.id, 'Continue from the recovered conversation context.');
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
