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
  effect
} from '@angular/core';
import { Router } from '@angular/router';
import { InstanceStore } from '../../core/state/instance.store';
import { HistoryStore } from '../../core/state/history.store';
import { CliStore } from '../../core/state/cli.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ChatStore } from '../../core/state/chat.store';
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
import { CommandPaletteComponent } from '../commands/command-palette.component';
import { CommandHelpHostComponent } from '../commands/command-help-host.component';
import { SessionPickerHostComponent } from '../sessions/session-picker-host.component';
import { ResumePickerHostComponent } from '../resume/resume-picker-host.component';
import { ModelPickerFocusService } from '../models/model-picker-focus.service';
import { PromptHistorySearchHostComponent } from '../prompt-history/prompt-history-search-host.component';
import { FileExplorerComponent } from '../file-explorer/file-explorer.component';
import { SourceControlComponent } from '../source-control/source-control.component';
import { isSourceControlEligible } from '../source-control/source-control-eligibility';
import { SourceControlStore } from '../../core/state/source-control.store';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { SidebarHeaderComponent } from './sidebar-header.component';
import { SidebarNavComponent } from './sidebar-nav.component';
import { SidebarFooterComponent } from './sidebar-footer.component';
import { WorkspaceRailComponent } from './workspace-rail.component';
import { BrowserPreviewNoticeComponent } from './browser-preview-notice.component';
import { SessionProgressPanelComponent } from '../instance-detail/session-progress-panel.component';
import { DEFAULT_KEYBINDING_ELIGIBILITY_STATE } from '../../../../shared/types/keybinding.types';

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
    CommandPaletteComponent,
    CommandHelpHostComponent,
    SessionPickerHostComponent,
    ResumePickerHostComponent,
    PromptHistorySearchHostComponent,
    FileExplorerComponent,
    SourceControlComponent,
    SidebarHeaderComponent,
    WorkspaceRailComponent,
    SidebarNavComponent,
    SidebarFooterComponent,
    BrowserPreviewNoticeComponent,
    SessionProgressPanelComponent
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardComponent implements OnInit, OnDestroy {
  private router = inject(Router);
  store = inject(InstanceStore);
  historyStore = inject(HistoryStore);
  cliStore = inject(CliStore);
  settingsStore = inject(SettingsStore);
  chatStore = inject(ChatStore);
  private remoteNodeStore = inject(RemoteNodeStore);
  private electronIpc = inject(ElectronIpcService);
  private actionDispatch = inject(ActionDispatchService);
  keybindingService = inject(KeybindingService);
  private viewLayoutService = inject(ViewLayoutService);
  private newSessionDraft = inject(NewSessionDraftService);
  private scratchDirectory = inject(ScratchDirectoryService);
  private visibleInstanceResolver = inject(VisibleInstanceResolver);
  private modelPickerFocusService = inject(ModelPickerFocusService);
  sourceControlStore = inject(SourceControlStore);

  showHistory = signal(false);
  showCommandPalette = signal(false);
  showCommandHelp = signal(false);
  showSessionPicker = signal(false);
  showResumePicker = signal(false);
  showPromptHistorySearch = signal(false);
  showControlPlane = signal(false);
  showSidebar = signal(true);
  showFileExplorer = signal(false);
  showSourceControl = signal(false);

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

  // Selected instance for the floating session-progress HUD. Rendered at
  // dashboard level (anchored to .main-content) so it docks against the
  // workspace scrollbar instead of floating over the centred chat column.
  // Null while a chat is selected so the HUD doesn't overlap chat-detail.
  progressPanelInstance = computed(() =>
    this.chatStore.selectedChatId() ? null : this.store.selectedInstance()
  );

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
  private lastAutoOpenedDraftWorkspace = signal<string | null>(null);

  private actionCleanup: (() => void)[] = [];

  constructor() {
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
      const workspacePath = this.activeWorkspaceWorkingDir();
      const hasDraftWorkspace =
        !this.store.selectedInstance()
        && !this.chatStore.selectedChatId()
        && !this.historyStore.previewConversation()
        && !!workspacePath;

      if (!hasDraftWorkspace) {
        this.lastAutoOpenedDraftWorkspace.set(null);
        return;
      }

      if (workspacePath === this.lastAutoOpenedDraftWorkspace()) {
        return;
      }

      this.lastAutoOpenedDraftWorkspace.set(workspacePath);
      this.showFileExplorer.set(true);
      this.showSourceControl.set(this.canShowSourceControl());
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
        id: 'toggle-command-palette',
        when: ['instance-selected'],
        run: () => {
          this.showCommandPalette.set(!this.showCommandPalette());
        },
      }),
      this.actionDispatch.register({
        id: 'toggle-settings',
        run: () => {
          void this.router.navigate(['/settings']);
        },
      }),
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
        id: 'new-instance',
        run: () => {
          this.createInstance();
        },
      }),
      this.actionDispatch.register({
        id: 'close-instance',
        when: ['instance-selected'],
        run: () => {
          const instance = this.store.selectedInstance();
          if (instance) {
            void this.store.terminateInstance(instance.id);
          }
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
          if (this.showCommandPalette()) {
            this.showCommandPalette.set(false);
            return;
          }

          if (this.showCommandHelp()) {
            this.showCommandHelp.set(false);
            return;
          }

          if (this.showSessionPicker()) {
            this.showSessionPicker.set(false);
            return;
          }

          if (this.showPromptHistorySearch()) {
            this.showPromptHistorySearch.set(false);
            return;
          }

          if (this.showHistory()) {
            this.showHistory.set(false);
            return;
          }

          const instance = this.store.selectedInstance();
          if (instance && (
            instance.status === 'busy'
            || instance.status === 'respawning'
            || instance.status === 'interrupting'
            || instance.status === 'cancelling'
            || instance.status === 'interrupt-escalating'
          )) {
            void this.store.interruptInstance(instance.id);
          }
        },
      }),
      this.actionDispatch.register({
        id: 'app.open-rlm',
        run: () => {
          this.openRlm();
        },
      }),
      this.actionDispatch.register({
        id: 'app.open-browser',
        run: () => {
          this.openBrowser();
        },
      }),
      this.actionDispatch.register({
        id: 'app.open-doctor',
        run: () => {
          this.openDoctor();
        },
      }),
      this.actionDispatch.register({
        id: 'app.open-command-help',
        run: () => {
          this.showCommandHelp.set(true);
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
          this.showResumePicker.set(true);
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

  createInstance(): void {
    const workingDirectory = this.settingsStore.settings().defaultWorkingDirectory || null;
    this.chatStore.deselect();
    this.historyStore.clearSelection();
    this.newSessionDraft.open(workingDirectory);
    this.store.setSelectedInstance(null);
  }

  /**
   * Start a general chat — a regular session that runs in the dedicated
   * scratch directory rather than a project workspace. It renders exactly like
   * any other session and is grouped under the "Chats" rail group.
   */
  async createGeneralChat(): Promise<void> {
    await this.scratchDirectory.init();
    const scratchDir = this.scratchDirectory.dir();
    this.chatStore.deselect();
    this.historyStore.clearSelection();
    this.newSessionDraft.open(scratchDir);
    this.store.setSelectedInstance(null);
  }

  selectChats(): void {
    this.historyStore.clearSelection();
    this.store.setSelectedInstance(null);
    this.showFileExplorer.set(false);
    this.showSourceControl.set(false);
    void this.chatStore.selectFirstChat();
  }

  closeAllInstances(): void {
    this.store.terminateAllInstances();
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

  openRlm(): void {
    this.router.navigate(['/rlm']);
  }

  async openBrowser(): Promise<void> {
    const navigated = await this.router.navigate(['/browser']);
    if (!navigated) {
      console.warn('[app.open-browser] Navigation to /browser was cancelled');
    }
  }

  openDoctor(): void {
    void this.router.navigate(['/settings'], {
      fragment: 'doctor',
    });
  }

  onRetryCliDetection(): void {
    this.cliStore.refresh();
  }

  onCommandExecuted(event: { commandId: string; args: string[] }): void {
    console.log('Command executed:', event);
    // Command execution is handled by the palette component via CommandStore
    if (event.commandId === 'builtin-rlm') {
      this.openRlm();
    }
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
