/**
 * Dashboard Component - Main application layout
 */

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
import { ViewLayoutService } from '../../core/services/view-layout.service';
import { VisibleInstanceResolver } from '../../core/services/visible-instance-resolver.service';
import { InstanceListComponent } from '../instance-list/instance-list.component';
import { InstanceDetailComponent } from '../instance-detail/instance-detail.component';
import { ChatSidebarComponent } from '../chats/chat-sidebar.component';
import { ChatDetailComponent } from '../chats/chat-detail.component';
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
import { SidebarActionsComponent } from './sidebar-actions.component';
import { BrowserPreviewNoticeComponent } from './browser-preview-notice.component';
import { SessionProgressPanelComponent } from '../instance-detail/session-progress-panel.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    InstanceListComponent,
    InstanceDetailComponent,
    ChatSidebarComponent,
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
    SidebarActionsComponent,
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

  private readonly anyTransientOverlayOpen = computed(() =>
    this.showCommandPalette()
    || this.showCommandHelp()
    || this.showSessionPicker()
    || this.showResumePicker()
    || this.showPromptHistorySearch()
    || this.showHistory()
  );

  // Computed: selected instance's working directory for file explorer
  selectedInstanceWorkingDir = computed(() => {
    const instance = this.store.selectedInstance();
    return instance?.workingDirectory || null;
  });

  // Computed: selected instance's execution node ID (null for local)
  selectedInstanceExecutionNodeId = computed(() => {
    const inst = this.store.selectedInstance();
    if (!inst?.executionLocation || inst.executionLocation.type === 'local') return null;
    return inst.executionLocation.nodeId;
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
    !!this.store.selectedInstance() && !this.chatStore.selectedChatId() && !this.isBenchmarkMode()
  );

  // Source Control has stricter eligibility than File Explorer: it also
  // excludes remote instances (Tier D in the Phase 2 plan) and missing
  // working directories (panel would land on an empty state). Implemented
  // as a pure predicate in `source-control-eligibility.ts` so the rule is
  // unit-testable without Angular DI.
  canShowSourceControl = computed(() => {
    const instance = this.store.selectedInstance();
    return isSourceControlEligible({
      hasSelectedInstance: !!instance,
      hasSelectedChat: !!this.chatStore.selectedChatId(),
      isBenchmarkMode: this.isBenchmarkMode(),
      isRemote: instance?.executionLocation?.type === 'remote',
      workingDirectory: instance?.workingDirectory ?? null,
    });
  });

  hasWorkspaceSelection = computed(() =>
    !!this.chatStore.selectedChatId() || !!this.store.selectedInstance() || !!this.historyStore.previewConversation()
  );

  showBrowserPreview = computed(() =>
    !this.electronIpc.isElectron && !this.isBenchmarkMode()
  );

  // Sidebar resize state - using ViewLayoutService for persistence
  sidebarWidth = signal(this.viewLayoutService.sidebarWidth);
  isResizing = signal(false);
  private resizeStartX = 0;
  private resizeStartWidth = 0;

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

    // Eager-load source control state on every eligible instance change.
    // This is what makes the header pip accurate before the user even
    // opens the panel. The store has stale-response protection so rapid
    // instance switches don't cause cross-contamination.
    effect(() => {
      if (this.canShowSourceControl()) {
        void this.sourceControlStore.loadForRoot(this.selectedInstanceWorkingDir());
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
    this.resizeStartWidth = this.sidebarWidth();
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (!this.isResizing()) return;

    const delta = event.clientX - this.resizeStartX;
    const newWidth = Math.max(
      260,
      Math.min(600, this.resizeStartWidth + delta)
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
  }

  toggleFileExplorer(): void {
    if (!this.canShowFileExplorer()) {
      this.showFileExplorer.set(false);
      return;
    }

    this.showFileExplorer.update((open) => !open);
  }

  toggleSourceControl(): void {
    if (!this.canShowSourceControl()) {
      this.showSourceControl.set(false);
      return;
    }

    this.showSourceControl.update((open) => !open);
  }

  navigateToSettings(): void {
    void this.router.navigate(['/settings']);
  }

  openRlm(): void {
    this.router.navigate(['/rlm']);
  }

  openBrowser(): void {
    void this.router.navigate(['/browser']);
  }

  openDoctor(): void {
    void this.router.navigate(['/settings'], {
      queryParams: { tab: 'doctor' },
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
  }
}
