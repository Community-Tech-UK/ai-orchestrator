/**
 * Dashboard Component - Main application layout
 */
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnInit,
  OnDestroy,
  signal,
  computed,
  HostListener,
  effect,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { InstanceStore } from '../../core/state/instance.store';
import { HistoryStore } from '../../core/state/history.store';
import { CliStore } from '../../core/state/cli.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ChatStore } from '../../core/state/chat.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import { sideChatParentFor, sideChatParentSelectionFor } from '../side-chat/side-chat-parent';
import type { SideChatParentRef } from '../../../../shared/types/side-chat.types';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { ViewLayoutService, type WorkspacePresetId } from '../../core/services/view-layout.service';
import { VisibleInstanceResolver } from '../../core/services/visible-instance-resolver.service';
import { InstanceListComponent } from '../instance-list/instance-list.component';
import { InstanceDetailComponent } from '../instance-detail/instance-detail.component';
import { ChatDetailComponent } from '../chats/chat-detail.component';
import { ScratchDirectoryService } from '../../core/services/scratch-directory.service';
import { CliErrorComponent } from '../cli-error/cli-error.component';
import { HistorySidebarComponent } from '../history/history-sidebar.component';
import { PaletteOverlaysService } from '../commands/palette-overlays.service';
import { SessionPickerHostComponent } from '../sessions/session-picker-host.component';
import { ResumePickerHostComponent } from '../resume/resume-picker-host.component';
import { ResumePickerController } from '../resume/resume-picker.controller';
import { ModelPickerFocusService } from '../models/model-picker-focus.service';
import { PromptHistorySearchHostComponent } from '../prompt-history/prompt-history-search-host.component';
import { FileExplorerComponent } from '../file-explorer/file-explorer.component';
import { SourceControlComponent } from '../source-control/source-control.component';
import { SideChatPanelComponent } from '../side-chat/side-chat-panel.component';
import { isSourceControlEligible } from '../source-control/source-control-eligibility';
import { SourceControlStore } from '../../core/state/source-control.store';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { SidebarHeaderComponent } from './sidebar-header.component';
import { SidebarNavComponent } from './sidebar-nav.component';
import { SidebarFooterComponent } from './sidebar-footer.component';
import { WorkspaceRailComponent } from './workspace-rail.component';
import { BrowserPreviewNoticeComponent } from './browser-preview-notice.component';
import { DEFAULT_KEYBINDING_ELIGIBILITY_STATE } from '../../../../shared/types/keybinding.types';
import {
  resolveDashboardProjectContext,
  type DashboardProjectContext,
} from './dashboard-project-context';
import { runCancelOperationCascade } from './dashboard-cancel-operation';
import { resolveArchivedSideChatContext } from './dashboard-archived-side-chat';
import { TerminateConfirmStore } from '../../shared/terminate-confirm/terminate-confirm.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { SessionRecoveryBannerComponent } from '../../shared/components/session-recovery-banner/session-recovery-banner.component';
import { FeatureUsageService } from '../../shared/tips/feature-usage.service';
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    InstanceListComponent,
    InstanceDetailComponent,
    ChatDetailComponent,
    CliErrorComponent,
    HistorySidebarComponent,
    SessionPickerHostComponent,
    ResumePickerHostComponent,
    PromptHistorySearchHostComponent,
    FileExplorerComponent,
    SourceControlComponent,
    SideChatPanelComponent,
    SidebarHeaderComponent,
    WorkspaceRailComponent,
    SidebarNavComponent,
    SidebarFooterComponent,
    BrowserPreviewNoticeComponent, SessionRecoveryBannerComponent,
    AioTooltipDirective,
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardComponent implements OnInit, OnDestroy {
  private readonly featureUsage = inject(FeatureUsageService);
  private router = inject(Router);
  store = inject(InstanceStore);
  private terminateConfirm = inject(TerminateConfirmStore);
  historyStore = inject(HistoryStore);
  cliStore = inject(CliStore);
  settingsStore = inject(SettingsStore);
  chatStore = inject(ChatStore);
  private sideChatStore = inject(SideChatStore);
  private remoteNodeStore = inject(RemoteNodeStore);
  private electronIpc = inject(ElectronIpcService);
  private actionDispatch = inject(ActionDispatchService);
  keybindingService = inject(KeybindingService);
  private viewLayoutService = inject(ViewLayoutService);
  private newSessionDraft = inject(NewSessionDraftService);
  private scratchDirectory = inject(ScratchDirectoryService);
  private visibleInstanceResolver = inject(VisibleInstanceResolver);
  private modelPickerFocusService = inject(ModelPickerFocusService);
  private resumePickerController = inject(ResumePickerController);
  sourceControlStore = inject(SourceControlStore);

  showHistory = signal(false);
  private readonly paletteOverlays = inject(PaletteOverlaysService);
  showCommandPalette = this.paletteOverlays.commandPaletteOpen;
  showCommandHelp = this.paletteOverlays.commandHelpOpen;
  showSessionPicker = signal(false);
  showResumePicker = signal(false);
  showPromptHistorySearch = signal(false);
  showControlPlane = signal(false);
  showSidebar = signal(true);
  showFileExplorer = signal(false);
  showSourceControl = signal(false);
  showSideChat = signal(false);

  // Workspace layout presets (copilot_todo.md item 9).
  readonly workspacePresets = this.viewLayoutService.presets;
  readonly activeWorkspacePreset = this.viewLayoutService.activePreset;

  // Whether the control plane is docked (pinned) vs a floating overlay
  // (copilot_todo.md item 7). Persisted by ViewLayoutService.
  readonly controlPlanePinned = this.viewLayoutService.controlPlanePinned;

  private readonly anyTransientOverlayOpen = computed(() =>
    this.showCommandPalette()
    || this.showCommandHelp()
    || this.showSessionPicker()
    || this.showResumePicker()
    || this.showPromptHistorySearch()
    || this.showHistory()
  );

  // Workspace chrome should follow the active workspace context, which can be
  // either a running instance or a draft session with a selected folder.
  activeWorkspaceWorkingDir = computed(() => {
    const instance = this.store.selectedInstance();
    if (instance?.workingDirectory) {
      return instance.workingDirectory;
    }

    return this.newSessionDraft.workingDirectory() || null;
  });

  // Remote file browsing is available for draft sessions too, so mirror the
  // selected execution node even before the first instance launches.
  activeWorkspaceExecutionNodeId = computed(() => {
    const instance = this.store.selectedInstance();
    if (instance?.executionLocation?.type === 'remote') {
      return instance.executionLocation.nodeId;
    }

    return this.newSessionDraft.nodeId();
  });

  isBenchmarkMode = computed(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    return new URLSearchParams(window.location.search).get('bench') === '1';
  });

  canShowFileExplorer = computed(() =>
    !!this.activeWorkspaceWorkingDir() && !this.chatStore.selectedChatId() && !this.isBenchmarkMode()
  );

  // Source Control has stricter eligibility than File Explorer: it also
  // excludes remote workspaces (Tier D in the Phase 2 plan) and missing
  // working directories (panel would land on an empty state). Implemented
  // as a pure predicate in `source-control-eligibility.ts` so the rule is
  // unit-testable without Angular DI.
  canShowSourceControl = computed(() => {
    const instance = this.store.selectedInstance();
    return isSourceControlEligible({
      hasSelectedInstance: !!this.activeWorkspaceWorkingDir(),
      hasSelectedChat: !!this.chatStore.selectedChatId(),
      isBenchmarkMode: this.isBenchmarkMode(),
      isRemote: instance?.executionLocation?.type === 'remote' || (!instance && !!this.newSessionDraft.nodeId()),
      workingDirectory: this.activeWorkspaceWorkingDir(),
    });
  });

  /** An archived badge may target a parent outside the main workspace. */
  private readonly archivedSideChatContext = signal<ReturnType<typeof resolveArchivedSideChatContext> | null>(null);

  /** Archived parent workspace, or the current workspace for live sidechats. */
  sideChatWorkingDirectory = computed(() => {
    const archived = this.archivedSideChatContext();
    return archived ? archived.workingDirectory
      : this.activeWorkspaceWorkingDir()
        ?? this.chatStore.selectedChat()?.currentCwd
        ?? this.scratchDirectory.dir()
        ?? null;
  });

  /** Parent session identity for session-linked sidechats. */
  sideChatParent = computed(() =>
    this.archivedSideChatContext()?.parent
    ?? sideChatParentFor(this.chatStore.selectedChat(), this.store.selectedInstance() ?? null));

  sideChatParentTitle = computed(() =>
    this.archivedSideChatContext()?.title
    ?? this.chatStore.selectedChat()?.name ?? this.store.selectedInstance()?.displayName ?? '');

  sideChatParentSelection = computed(() => {
    const archived = this.archivedSideChatContext();
    return archived
      ? archived.selection
      : sideChatParentSelectionFor(this.chatStore.selectedChat(), this.store.selectedInstance() ?? null);
  });

  /** Conversation a badge or attention list asked the panel to open. */
  sideChatPreferredChatId = signal<string | null>(null);

  hasWorkspaceSelection = computed(() =>
    !!this.chatStore.selectedChatId()
    || !!this.store.selectedInstance()
    || !!this.historyStore.previewConversation()
    || !!this.activeWorkspaceWorkingDir()
  );

  showBrowserPreview = computed(() =>
    !this.electronIpc.isElectron && !this.isBenchmarkMode()
  );

  // Sidebar resize state - using ViewLayoutService for persistence
  sidebarWidth = signal(this.viewLayoutService.sidebarWidth);
  effectiveSidebarWidth = computed(() => {
    if (this.settingsStore.effectiveSidebarStyle() !== 'compact') {
      return this.sidebarWidth();
    }
    return Math.min(this.sidebarWidth(), 280);
  });
  isResizing = signal(false);
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private actionCleanup: (() => void)[] = [];

  constructor() {
    void this.sideChatStore.initialize();
    effect(() => {
      const request = this.sideChatStore.openRequest();
      if (request) {
        untracked(() => this.openSideChatFor(request.parent, request.chatId));
      }
    });

    // An archived request clears the main selection. Any subsequent selection
    // or panel closure ends its override, including reselecting the old session.
    effect(() => {
      const archived = this.archivedSideChatContext();
      if (archived && (!this.showSideChat()
        || this.store.selectedInstance()
        || this.chatStore.selectedChatId()
        || this.historyStore.previewConversation())) {
        this.clearSideChatContext();
      }
    });

    effect(() => {
      if (!this.canShowFileExplorer()) {
        this.showFileExplorer.set(false);
      }
    });

    effect(() => {
      if (!this.canShowSourceControl()) {
        this.showSourceControl.set(false);
      }
    });

    // Eager-load source control state for whichever workspace currently owns
    // the shell, including fresh drafts with a selected working directory.
    // The store has stale-response protection so rapid workspace switches
    // don't cause cross-contamination.
    effect(() => {
      if (this.canShowSourceControl()) {
        void this.sourceControlStore.loadForRoot(this.activeWorkspaceWorkingDir());
      } else {
        void this.sourceControlStore.loadForRoot(null);
      }
    });

    effect(() => {
      const hasProjectSelection = !!this.store.selectedInstance() || !!this.historyStore.previewConversation();
      if (hasProjectSelection && this.chatStore.selectedChatId()) {
        queueMicrotask(() => this.chatStore.deselect());
      }
    });

    effect(() => {
      const selectedInstance = this.store.selectedInstance();
      this.keybindingService.setEligibilityState({
        instanceSelected: !!selectedInstance,
        multipleInstances: this.store.instances().length > 1,
        instanceRunning:
          selectedInstance?.status === 'busy'
          || selectedInstance?.status === 'respawning'
          || selectedInstance?.status === 'interrupting'
          || selectedInstance?.status === 'cancelling'
          || selectedInstance?.status === 'interrupt-escalating',
        commandPaletteOpen: this.anyTransientOverlayOpen(),
        historyOpen: this.showHistory(),
        sidebarVisible: this.showSidebar(),
        chatSelected: !!this.chatStore.selectedChatId(),
      });
    });
  }

  onResizeStart(event: MouseEvent): void {
    event.preventDefault();
    this.isResizing.set(true);
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.effectiveSidebarWidth();
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (!this.isResizing()) return;

    const delta = event.clientX - this.resizeStartX;
    const maxWidth = this.settingsStore.effectiveSidebarStyle() === 'compact' ? 280 : 600;
    const newWidth = Math.max(
      260,
      Math.min(maxWidth, this.resizeStartWidth + delta)
    );
    this.sidebarWidth.set(newWidth);
    // Update service (debounced save)
    this.viewLayoutService.setSidebarWidth(newWidth);
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    if (this.isResizing()) {
      this.isResizing.set(false);
    }
  }

  ngOnInit(): void {
    // Initialize settings first, then CLI detection
    this.settingsStore.initialize().then(() => {
      if (!this.showBrowserPreview()) {
        this.cliStore.initialize();
      }
    });

    // Initialize remote node store (seeds from IPC + subscribes to live updates)
    void this.remoteNodeStore.initialize();
    void this.scratchDirectory.init();

    this.resumePickerController.ensureCandidatesLoaded();

    // Register keybinding handlers
    this.registerKeybindingHandlers();
  }

  /**
   * Register all keybinding handlers
   */
  private registerKeybindingHandlers(): void {
    const visibleInstanceActions = Array.from({ length: 9 }, (_, index) => {
      const slot = index + 1;
      return this.actionDispatch.register({
        id: `select-visible-instance-${slot}`,
        when: ['multiple-instances'],
        run: () => {
          this.visibleInstanceResolver.selectVisibleInstance(slot);
        },
      });
    });

    this.actionCleanup.push(
      this.actionDispatch.register({
        id: 'select-orchestrator',
        run: () => {
          this.selectChats();
        },
      }),
      ...visibleInstanceActions,
      this.actionDispatch.register({
        id: 'toggle-history',
        run: () => {
          this.showHistory.set(!this.showHistory());
        },
      }),
      this.actionDispatch.register({
        id: 'toggle-sidebar',
        run: () => {
          this.showSidebar.set(!this.showSidebar());
        },
      }),
      this.actionDispatch.register({
        id: 'toggle-side-chat',
        run: () => {
          this.toggleSideChat();
        },
      }),
      this.actionDispatch.register({
        id: 'new-instance',
        run: () => this.createInstance(),
      }),
      this.actionDispatch.register({
        id: 'close-instance',
        when: ['instance-selected'],
        run: () => {
          const instance = this.store.selectedInstance();
          // Decision 16(b): Cmd+W is the default binding for this action, and it
          // used to end the session outright. Closing kills the agent and loses
          // unsaved work, so it asks first, exactly as the row's × button does.
          if (instance) this.terminateConfirm.request(instance.id);
        },
      }),
      this.actionDispatch.register({
        id: 'next-instance',
        when: ['multiple-instances'],
        run: () => {
          const instances = this.store.instances();
          const selected = this.store.selectedInstance();
          if (instances.length > 1 && selected) {
            const currentIndex = instances.findIndex((instance) => instance.id === selected.id);
            const nextIndex = (currentIndex + 1) % instances.length;
            this.store.setSelectedInstance(instances[nextIndex].id);
          }
        },
      }),
      this.actionDispatch.register({
        id: 'prev-instance',
        when: ['multiple-instances'],
        run: () => {
          const instances = this.store.instances();
          const selected = this.store.selectedInstance();
          if (instances.length > 1 && selected) {
            const currentIndex = instances.findIndex((instance) => instance.id === selected.id);
            const prevIndex =
              currentIndex === 0 ? instances.length - 1 : currentIndex - 1;
            this.store.setSelectedInstance(instances[prevIndex].id);
          }
        },
      }),
      this.actionDispatch.register({
        id: 'restart-instance',
        when: ['instance-selected'],
        run: () => {
          const instance = this.store.selectedInstance();
          if (instance) {
            void this.store.restartInstance(instance.id);
          }
        },
      }),
      this.actionDispatch.register({
        id: 'cancel-operation',
        when: ['command-palette-open', 'history-open', 'instance-running'],
        run: () => {
          runCancelOperationCascade({
            showCommandPalette: this.showCommandPalette,
            showCommandHelp: this.showCommandHelp,
            showSessionPicker: this.showSessionPicker,
            showPromptHistorySearch: this.showPromptHistorySearch,
            showHistory: this.showHistory,
            selectedInstance: () => this.store.selectedInstance(),
            interruptInstance: (instanceId) => this.store.interruptInstance(instanceId),
          });
        },
      }),
      this.actionDispatch.register({
        id: 'open-session-picker',
        run: () => {
          this.showSessionPicker.set(true);
        },
      }),
      this.actionDispatch.register({
        id: 'resume.openPicker',
        run: () => {
          this.openResumePicker();
        },
      }),
      this.actionDispatch.register({
        id: 'open-model-picker',
        when: ['chat-selected'],
        run: () => {
          this.modelPickerFocusService.requestOpen();
        },
      }),
      this.actionDispatch.register({
        id: 'open-prompt-history-search',
        when: ['instance-selected'],
        run: () => {
          this.showPromptHistorySearch.set(true);
        },
      }),
    );
  }

  async createInstance(): Promise<void> {
    await this.scratchDirectory.init();
    const context = this.getCurrentProjectContext();
    this.openNewSessionDraft(
      context?.workingDirectory ?? this.settingsStore.settings().defaultWorkingDirectory ?? null,
      context?.nodeId ?? null,
    );
  }

  /**
   * Start a new chat. When the user is already viewing a project, keep the
   * draft in that project; otherwise use the dedicated scratch directory for a
   * general chat.
   */
  async createGeneralChat(forceScratch = false): Promise<void> {
    await this.scratchDirectory.init();
    const context = this.getCurrentProjectContext();
    if (context && !forceScratch) {
      this.openNewSessionDraft(context.workingDirectory, context.nodeId);
      return;
    }

    const scratchDir = this.scratchDirectory.dir() ?? null;
    this.openNewSessionDraft(scratchDir, null);
  }

  private openNewSessionDraft(workingDirectory: string | null, nodeId: string | null): void {
    this.chatStore.deselect();
    this.historyStore.clearSelection();
    this.newSessionDraft.open(workingDirectory, nodeId, {
      hintWorkspace: !workingDirectory || !this.scratchDirectory.isScratch(workingDirectory),
    });
    this.store.setSelectedInstance(null);
  }

  private getCurrentProjectContext(): DashboardProjectContext | null {
    const selectedInstance = this.store.selectedInstance();
    const selectedChat = this.chatStore.selectedChatId()
      ? this.chatStore.selectedChat()
      : null;
    const previewConversation = this.historyStore.previewConversation();
    return resolveDashboardProjectContext({
      selectedInstance,
      selectedChat: this.chatStore.selectedChatId()
        ? { currentCwd: selectedChat?.currentCwd ?? null }
        : null,
      previewConversation: previewConversation
        ? {
            workingDirectory: previewConversation.entry.workingDirectory,
            executionLocation: previewConversation.entry.executionLocation ?? null,
          }
        : null,
      draftWorkingDirectory: this.newSessionDraft.workingDirectory(),
      draftNodeId: this.newSessionDraft.nodeId(),
      isScratch: (workingDirectory) => this.scratchDirectory.isScratch(workingDirectory),
    });
  }

  selectChats(): void {
    this.historyStore.clearSelection();
    this.store.setSelectedInstance(null);
    this.showFileExplorer.set(false);
    this.showSourceControl.set(false);
    void this.chatStore.selectFirstChat();
  }

  openRecoveryPicker(): void {
    this.resumePickerController.focusRecoveryContent();
    this.showResumePicker.set(true);
  }

  openResumePicker(): void { this.resumePickerController.resetTransientFocus(); this.showResumePicker.set(true); }

  closeResumePicker(): void { this.resumePickerController.resetTransientFocus(); this.showResumePicker.set(false); }

  closeAllInstances(): void {
    this.terminateConfirm.requestAll();
  }

  toggleControlPlane(): void {
    this.showControlPlane.update((open) => !open);
    this.viewLayoutService.setActivePreset(null);
  }

  /**
   * Toggle the control plane between docked (pinned) and floating overlay.
   * The pinned state is persisted by ViewLayoutService so it survives reloads.
   */
  toggleControlPlanePinned(): void {
    this.viewLayoutService.setControlPlanePinned(!this.controlPlanePinned());
  }

  /** Apply a named workspace layout preset (copilot_todo.md item 9). */
  applyWorkspacePreset(id: WorkspacePresetId): void {
    const preset = this.viewLayoutService.getPreset(id);
    this.viewLayoutService.setActivePreset(id);
    this.showSidebar.set(preset.panels.sidebar);
    this.showControlPlane.set(preset.panels.controlPlane);
    this.showFileExplorer.set(preset.panels.fileExplorer && this.canShowFileExplorer());
    this.showSourceControl.set(preset.panels.sourceControl && this.canShowSourceControl());
    if (!preset.panels.sideChat) this.clearSideChatContext();
    this.showSideChat.set(preset.panels.sideChat ?? false);
  }

  /** Close the panel and return keyboard focus to the rail button that opens it. */
  closeSideChat(): void {
    this.clearSideChatContext();
    this.showSideChat.set(false);
    queueMicrotask(() => document.querySelector<HTMLElement>('app-workspace-rail button[data-testid="sidechat-toggle"]')?.focus());
  }

  toggleSideChat(): void {
    this.clearSideChatContext();
    this.showSideChat.update((open) => !open);
    if (this.showSideChat()) this.featureUsage.record('toggle-side-chat');
    this.viewLayoutService.setActivePreset(null);
  }

  /**
   * Promote the side chat into the main workspace view (clears the instance /
   * history selection first, mirroring `selectChats()`). Closes the panel so
   * the same chat isn't rendered twice.
   */
  openSideChatInMain(chatId: string): void {
    this.clearSideChatContext();
    this.historyStore.clearSelection();
    this.store.setSelectedInstance(null);
    this.showFileExplorer.set(false);
    this.showSourceControl.set(false);
    this.showSideChat.set(false);
    void this.chatStore.select(chatId);
  }

  /** Open the exact sidechat in its parent's panel without starting the parent. */
  private openSideChatFor(parent: SideChatParentRef, chatId: string | null): void {
    const live = parent.kind === 'session' ? this.store.instances().find((instance) =>
      instance.historyThreadId === parent.historyThreadId && instance.status !== 'terminated') : null;
    const archived = parent.kind === 'session' && !live ? resolveArchivedSideChatContext(
      parent, this.historyStore.previewConversation()?.entry ?? null, this.historyStore.entries(),
      this.sideChatStore.attentionFor(parent)?.parentTitle ?? null,
    ) : null;
    this.clearSideChatContext();
    this.historyStore.clearSelection();
    this.chatStore.deselect();
    this.store.setSelectedInstance(live?.id ?? null);
    if (parent.kind === 'chat') void this.chatStore.select(parent.chatId);
    this.archivedSideChatContext.set(archived);
    this.sideChatPreferredChatId.set(chatId);
    this.showSideChat.set(true);
  }

  private clearSideChatContext(): void {
    this.archivedSideChatContext.set(null);
    this.sideChatPreferredChatId.set(null);
  }

  toggleFileExplorer(): void {
    if (!this.canShowFileExplorer()) {
      this.showFileExplorer.set(false);
      return;
    }

    this.showFileExplorer.update((open) => !open);
    this.viewLayoutService.setActivePreset(null);
  }

  toggleSourceControl(): void {
    if (!this.canShowSourceControl()) {
      this.showSourceControl.set(false);
      return;
    }

    this.showSourceControl.update((open) => !open);
    this.viewLayoutService.setActivePreset(null);
  }

  navigateToSettings(): void {
    void this.router.navigate(['/settings']);
  }

  onRetryCliDetection(): void {
    this.cliStore.refresh();
  }

  onFileDragged(event: {
    path: string;
    name: string;
    isDirectory: boolean;
  }): void {
    // File dragged from explorer - can be used for drag preview feedback
    console.log('File dragged from explorer:', event);
  }

  onFilesDragged(event: { paths: string[]; names: string[] }): void {
    // Multi-file drag from explorer - can be used for drag preview feedback
    console.log('Files dragged from explorer:', event.paths.length, 'files');
  }

  ngOnDestroy(): void {
    this.actionCleanup.forEach((cleanup) => cleanup());
    this.actionCleanup = [];
    this.keybindingService.setEligibilityState(DEFAULT_KEYBINDING_ELIGIBILITY_STATE);
  }
}
