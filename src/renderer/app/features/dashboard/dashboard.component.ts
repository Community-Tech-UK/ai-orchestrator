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
import { CliStore } from '../../core/state/cli.store';
import { SettingsStore } from '../../core/state/settings.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { KeybindingService } from '../../core/services/keybinding.service';
import { ViewLayoutService } from '../../core/services/view-layout.service';
import { InstanceListComponent } from '../instance-list/instance-list.component';
import { InstanceDetailComponent } from '../instance-detail/instance-detail.component';
import { CliErrorComponent } from '../cli-error/cli-error.component';
import { HistorySidebarComponent } from '../history/history-sidebar.component';
import { CommandPaletteComponent } from '../commands/command-palette.component';
import { FileExplorerComponent } from '../file-explorer/file-explorer.component';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { SidebarHeaderComponent } from './sidebar-header.component';
import { SidebarNavComponent } from './sidebar-nav.component';
import { SidebarFooterComponent } from './sidebar-footer.component';
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
    FileExplorerComponent,
    SidebarHeaderComponent,
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
  cliStore = inject(CliStore);
  settingsStore = inject(SettingsStore);
  private remoteNodeStore = inject(RemoteNodeStore);
  private electronIpc = inject(ElectronIpcService);
  keybindingService = inject(KeybindingService);
  private viewLayoutService = inject(ViewLayoutService);
  private newSessionDraft = inject(NewSessionDraftService);

  showHistory = signal(false);
  showCommandPalette = signal(false);
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

  showBrowserPreview = computed(() =>
    !this.electronIpc.isElectron && !this.isBenchmarkMode()
  );

  // Sidebar resize state - using ViewLayoutService for persistence
  sidebarWidth = signal(this.viewLayoutService.sidebarWidth);
  isResizing = signal(false);
  private resizeStartX = 0;
  private resizeStartWidth = 0;

  private keybindingCleanup: (() => void)[] = [];

  constructor() {
    effect(() => {
      if (!this.canShowFileExplorer()) {
        this.showFileExplorer.set(false);
      }
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
    // Command palette - Cmd+Shift+P or Cmd+K
    this.keybindingCleanup.push(
      this.keybindingService.onAction('toggle-command-palette', () => {
        if (this.store.selectedInstance()) {
          this.showCommandPalette.set(!this.showCommandPalette());
        }
      })
    );

    // Settings - Cmd+,
    this.keybindingCleanup.push(
      this.keybindingService.onAction('toggle-settings', () => {
        void this.router.navigate(['/settings']);
      })
    );

    // History - Cmd+H
    this.keybindingCleanup.push(
      this.keybindingService.onAction('toggle-history', () => {
        this.showHistory.set(!this.showHistory());
      })
    );

    // Sidebar toggle - Cmd+B
    this.keybindingCleanup.push(
      this.keybindingService.onAction('toggle-sidebar', () => {
        this.showSidebar.set(!this.showSidebar());
      })
    );

    // New instance - Cmd+N
    this.keybindingCleanup.push(
      this.keybindingService.onAction('new-instance', () => {
        this.createInstance();
      })
    );

    // Close instance - Cmd+W
    this.keybindingCleanup.push(
      this.keybindingService.onAction('close-instance', () => {
        const instance = this.store.selectedInstance();
        if (instance) {
          this.store.terminateInstance(instance.id);
        }
      })
    );

    // Next instance - Ctrl+Tab
    this.keybindingCleanup.push(
      this.keybindingService.onAction('next-instance', () => {
        const instances = this.store.instances();
        const selected = this.store.selectedInstance();
        if (instances.length > 1 && selected) {
          const currentIndex = instances.findIndex((i) => i.id === selected.id);
          const nextIndex = (currentIndex + 1) % instances.length;
          this.store.setSelectedInstance(instances[nextIndex].id);
        }
      })
    );

    // Previous instance - Ctrl+Shift+Tab
    this.keybindingCleanup.push(
      this.keybindingService.onAction('prev-instance', () => {
        const instances = this.store.instances();
        const selected = this.store.selectedInstance();
        if (instances.length > 1 && selected) {
          const currentIndex = instances.findIndex((i) => i.id === selected.id);
          const prevIndex =
            currentIndex === 0 ? instances.length - 1 : currentIndex - 1;
          this.store.setSelectedInstance(instances[prevIndex].id);
        }
      })
    );

    // Restart instance - Cmd+Shift+R
    this.keybindingCleanup.push(
      this.keybindingService.onAction('restart-instance', () => {
        const instance = this.store.selectedInstance();
        if (instance) {
          this.store.restartInstance(instance.id);
        }
      })
    );

    // Cancel operation - Escape
    this.keybindingCleanup.push(
      this.keybindingService.onAction('cancel-operation', () => {
        // Close any open modals first
        if (this.showCommandPalette()) {
          this.showCommandPalette.set(false);
        } else if (this.showHistory()) {
          this.showHistory.set(false);
        } else {
          // No modals open - interrupt the selected instance if busy
          const instance = this.store.selectedInstance();
          if (instance && instance.status === 'busy') {
            this.store.interruptInstance(instance.id);
          }
        }
      })
    );
  }

  createInstance(): void {
    const workingDirectory = this.settingsStore.settings().defaultWorkingDirectory || null;
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
    // Cleanup keybinding handlers
    this.keybindingCleanup.forEach((cleanup) => cleanup());
    this.keybindingCleanup = [];
  }
}
