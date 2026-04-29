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
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { ViewLayoutService } from '../../core/services/view-layout.service';
import { VisibleInstanceResolver } from '../../core/services/visible-instance-resolver.service';
import { InstanceListComponent } from '../instance-list/instance-list.component';
import { InstanceDetailComponent } from '../instance-detail/instance-detail.component';
import { CliErrorComponent } from '../cli-error/cli-error.component';
import { HistorySidebarComponent } from '../history/history-sidebar.component';
import { CommandPaletteComponent } from '../commands/command-palette.component';
import { CommandHelpHostComponent } from '../commands/command-help-host.component';
import { SessionPickerHostComponent } from '../sessions/session-picker-host.component';
import { ResumePickerHostComponent } from '../resume/resume-picker-host.component';
import { ModelPickerHostComponent } from '../models/model-picker-host.component';
import { PromptHistorySearchHostComponent } from '../prompt-history/prompt-history-search-host.component';
import { FileExplorerComponent } from '../file-explorer/file-explorer.component';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { SidebarHeaderComponent } from './sidebar-header.component';
import { SidebarNavComponent } from './sidebar-nav.component';
import { SidebarFooterComponent } from './sidebar-footer.component';
import { SidebarActionsComponent } from './sidebar-actions.component';
import { BrowserPreviewNoticeComponent } from './browser-preview-notice.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    InstanceListComponent,
    InstanceDetailComponent,
    CliErrorComponent,
    HistorySidebarComponent,
    CommandPaletteComponent,
    CommandHelpHostComponent,
    SessionPickerHostComponent,
    ResumePickerHostComponent,
    ModelPickerHostComponent,
    PromptHistorySearchHostComponent,
    FileExplorerComponent,
    SidebarHeaderComponent,
    SidebarActionsComponent,
    SidebarNavComponent,
    SidebarFooterComponent,
    BrowserPreviewNoticeComponent
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
  private remoteNodeStore = inject(RemoteNodeStore);
  private electronIpc = inject(ElectronIpcService);
  private actionDispatch = inject(ActionDispatchService);
  keybindingService = inject(KeybindingService);
  private viewLayoutService = inject(ViewLayoutService);
  private newSessionDraft = inject(NewSessionDraftService);
  private visibleInstanceResolver = inject(VisibleInstanceResolver);

  showHistory = signal(false);
  showCommandPalette = signal(false);
  showCommandHelp = signal(false);
  showSessionPicker = signal(false);
  showResumePicker = signal(false);
  showModelPicker = signal(false);
  showPromptHistorySearch = signal(false);
  showControlPlane = signal(false);
  showSidebar = signal(true);
  showFileExplorer = signal(false);

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

  isBenchmarkMode = computed(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    return new URLSearchParams(window.location.search).get('bench') === '1';
  });

  canShowFileExplorer = computed(() =>
    !!this.store.selectedInstance() && !this.isBenchmarkMode()
  );

  hasWorkspaceSelection = computed(() =>
    !!this.store.selectedInstance() || !!this.historyStore.previewConversation()
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
        commandPaletteOpen: this.showCommandPalette(),
        historyOpen: this.showHistory(),
        sidebarVisible: this.showSidebar(),
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

          if (this.showModelPicker()) {
            this.showModelPicker.set(false);
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
        when: ['instance-selected'],
        run: () => {
          this.showModelPicker.set(true);
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
    this.historyStore.clearSelection();
    this.newSessionDraft.open(workingDirectory);
    this.store.setSelectedInstance(null);
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

  navigateToSettings(): void {
    void this.router.navigate(['/settings']);
  }

  openRlm(): void {
    this.router.navigate(['/rlm']);
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
