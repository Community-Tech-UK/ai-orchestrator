/** Session header with status, badges, and actions. */

import {
  Component,
  input,
  output,
  computed,
  inject,
  effect,
  untracked,
  signal,
  viewChild,
  ElementRef,
  ChangeDetectionStrategy
} from '@angular/core';
import { StatusIndicatorComponent } from '../instance-list/status-indicator.component';
import { RecentDirectoriesDropdownComponent } from '../../shared/components/recent-directories-dropdown/recent-directories-dropdown.component';
import { CrossModelReviewIndicatorComponent } from './cross-model-review-indicator.component';
import { computerName } from '../../../../shared/display-names';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { isRemoteNodeOnline } from '../../core/state/remote-node-connectivity';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import type { Instance } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { resolveEffectiveInstanceTitle } from '../../../../shared/types/history.types';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { HelpLinkComponent } from '../../shared/help/help-link.component';
import { globalComputerUseLevel, resolveComputerUsePresentation } from './session-computer-use-control.component';
import { SessionCostLabelComponent } from './session-cost-label.component';
import { SessionOptionsMenuComponent } from './session-options-menu.component';
import type { ComputerUseAutonomyLevel } from '../../../../shared/types/desktop-gateway-settings.types';
import { agentModeName, remoteNodeTooltip, waitReasonDetail, waitReasonLabel } from './instance-header-presentation';
import { GlobalPauseStore } from '../../core/state/global-pause/global-pause.store';

interface EditorMenuItem {
  type: string;
  label: string;
}

@Component({
  selector: 'app-instance-header',
  standalone: true,
  imports: [StatusIndicatorComponent, RecentDirectoriesDropdownComponent, CrossModelReviewIndicatorComponent, SessionCostLabelComponent, SessionOptionsMenuComponent, AioTooltipDirective, HelpLinkComponent],
  templateUrl: './instance-header.component.html',
  styleUrl: './instance-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstanceHeaderComponent {
  private readonly settingsStore = inject(SettingsStore);
  private fileIpc = inject(FileIpcService);
  private electronIpc = inject(ElectronIpcService);
  private readonly remoteNodeStore = inject(RemoteNodeStore);
  protected readonly globalPause = inject(GlobalPauseStore);

  private nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  instance = input.required<Instance>();
  isEditingName = input(false);
  isChangingMode = input(false);
  isTogglingYolo = input(false);
  isTogglingFastMode = input(false);
  canShowFileExplorer = input(false);
  isFileExplorerOpen = input(false);
  canShowSourceControl = input(false);
  isSourceControlOpen = input(false);
  sourceControlChangeCount = input(0);
  /** What flipping auto-approve would cost (the session restarts), when that is worth saying. Shown in Session options. */
  yoloCostNote = input<string | null>(null);

  // Effective display title — delegates to the shared resolver so the header
  // stays in sync with the workspace rail list. See
  // `resolveEffectiveInstanceTitle` in shared/types/history.types.ts.
  readonly displayTitle = computed(() => resolveEffectiveInstanceTitle(this.instance()));

  showOpenMenu = signal(false);
  editorTargets = signal<EditorMenuItem[]>([]);
  isLoadingEditors = signal(false);
  private hasLoadedEditorTargets = false;

  readonly waitReasonLabel = computed(() => waitReasonLabel(this.instance().waitReason));
  readonly waitReasonDetail = computed(() => waitReasonDetail(this.instance().waitReason));

  // Chips: shown only when a setting is not its normal value, so a default session has none.
  /** A change to Auto-approve is queued (requested while busy) and applies on the next idle. */
  readonly yoloPending = computed(() => {
    const inst = this.instance();
    return inst.pendingYoloMode !== undefined && inst.pendingYoloMode !== inst.yoloMode;
  });
  /** The Auto-approve chip text, with the queued flip spelled out; `null` while it is off and nothing is queued. */
  readonly yoloLabel = computed(() => {
    const inst = this.instance();
    if (this.yoloPending()) return `Auto-approve → ${inst.pendingYoloMode ? 'on' : 'off'} after this reply`;
    return inst.yoloMode ? 'Auto-approve' : null;
  });
  readonly yoloChipTooltip = computed(() => this.yoloPending()
    ? 'Auto-approve changes after the current reply finishes. Change it in Session options'
    : 'Auto-approve is on: runs tools and edits without asking you. Change it in Session options');
  readonly modeChip = computed(() => {
    const mode = agentModeName(this.instance().agentId);
    return mode === 'Build' ? null : mode;
  });
  /** The session's Computer Use level, only when the feature is on and it differs from the global one. */
  readonly desktopControlLevel = computed<ComputerUseAutonomyLevel | null>(() => {
    const settings = this.settingsStore.settings();
    const mode = this.instance().computerUseMode;
    if (settings.computerUseEnabled !== true || !mode) return null;
    return resolveComputerUsePresentation(mode, globalComputerUseLevel(settings.computerUseAutonomyLevel)).relation === 'session' ? null : mode;
  });

  readonly isRemote = computed(() =>
    this.instance().executionLocation?.type === 'remote',
  );

  readonly remoteNodeId = computed(() => {
    const loc = this.instance().executionLocation;
    return loc?.type === 'remote' ? loc.nodeId : null;
  });

  readonly remoteNode = computed(() => {
    const id = this.remoteNodeId();
    return id ? this.remoteNodeStore.nodeById(id) ?? null : null;
  });

  /** The computer's own name, or a plain description when it has none. Never a raw node id. */
  readonly remoteNodeName = computed(() => {
    if (!this.remoteNodeId()) return '';
    const node = this.remoteNode();
    return computerName({ name: node?.name, platform: node?.capabilities?.platform });
  });

  readonly remoteNodeDisconnected = computed(() => {
    const node = this.remoteNode();
    return this.isRemote() && (!node || !isRemoteNodeOnline(node));
  });

  readonly remoteNodeTooltip = computed(() => remoteNodeTooltip(this.remoteNode(), this.remoteNodeName()));

  constructor() {
    // Seed + focus the name input whenever editing starts.
    // We set the value imperatively (instead of [value] binding) so that
    // background change-detection cycles (e.g. batch status updates) cannot
    // overwrite the text the user is typing.
    effect(() => {
      if (this.isEditingName()) {
        const input = this.nameInput()?.nativeElement;
        if (input) {
          input.value = untracked(() => this.instance().displayName);
          input.focus();
          input.select();
        }
      }
    });

    effect(() => {
      if (!this.showOpenMenu()) {
        return;
      }

      void this.ensureEditorTargetsLoaded();
    });
  }

  // Actions. Restart/terminate/create-child have moved to the session
  // right-click menu in the instance list, and Interrupt is the composer's
  // Stop button, so none of them are surfaced here.
  startEditName = output<void>();
  cancelEditName = output<void>();
  saveName = output<string>();
  cycleAgentMode = output<void>();
  toggleYolo = output<void>();
  toggleFastMode = output<void>();
  selectFolder = output<string>();
  toggleFileExplorer = output<void>();
  toggleSourceControl = output<void>();
  reviewPanelToggle = output<void>();

  /**
   * Compact pip label for the source-control icon. Clamps very large
   * counts to "99+" so the badge stays single-glyph wide.
   */
  sourceControlPipLabel = computed(() => {
    const n = this.sourceControlChangeCount();
    if (n <= 0) return '';
    return n > 99 ? '99+' : String(n);
  });

  /**
   * Hover title for the source-control icon. Surfaces the change count
   * so accessibility tools / hover users get the same signal the pip
   * conveys visually.
   */
  sourceControlButtonTitle = computed(() => {
    const n = this.sourceControlChangeCount();
    if (this.isSourceControlOpen()) return 'Hide source control';
    if (n <= 0) return 'Show source control';
    if (n === 1) return 'Show source control (1 change)';
    return `Show source control (${n} changes)`;
  });

  preferredEditorLabel = computed(() => {
    return this.editorTargets()[0]?.label || 'Editor';
  });

  systemFolderLabel = computed(() => {
    switch (this.electronIpc.platform) {
      case 'darwin':
        return 'Finder';
      case 'win32':
        return 'Explorer';
      default:
        return 'File Manager';
    }
  });

  onSaveName(event: Event): void {
    const input = event.target as HTMLInputElement;
    const newName = input.value.trim();
    if (newName && newName !== this.instance().displayName) {
      this.saveName.emit(newName);
    }
    this.cancelEditName.emit();
  }

  onToggleOpenMenu(event: Event): void {
    event.stopPropagation();
    this.showOpenMenu.update((current) => !current);
  }

  async openInPreferredEditor(): Promise<void> {
    const workingDirectory = this.instance().workingDirectory?.trim();
    if (!workingDirectory) {
      return;
    }

    await this.fileIpc.editorOpenDirectory(workingDirectory);
    this.showOpenMenu.set(false);
  }

  async openInSystemFileManager(): Promise<void> {
    const workingDirectory = this.instance().workingDirectory?.trim();
    if (!workingDirectory) {
      return;
    }

    await this.fileIpc.openPath(workingDirectory);
    this.showOpenMenu.set(false);
  }

  /** Open the system terminal at this instance's working directory, from the Open menu. */
  async openInTerminal(): Promise<void> {
    const workingDirectory = this.instance().workingDirectory?.trim();
    if (!workingDirectory) {
      return;
    }

    await this.fileIpc.openTerminalAtPath(workingDirectory);
    this.showOpenMenu.set(false);
  }

  private async ensureEditorTargetsLoaded(): Promise<void> {
    if (this.hasLoadedEditorTargets || this.isLoadingEditors()) {
      return;
    }

    this.isLoadingEditors.set(true);
    try {
      await this.fileIpc.editorDetect();

      const [defaultResponse, availableResponse] = await Promise.all([
        this.fileIpc.editorGetDefault(),
        this.fileIpc.editorGetAvailable(),
      ]);

      const targets: EditorMenuItem[] = [];
      const defaultEditor = this.parseEditorRecord(defaultResponse.data);
      if (defaultEditor?.type) {
        targets.push({
          type: defaultEditor.type,
          label: this.getEditorLabel(defaultEditor.type, defaultEditor.name),
        });
      } else if (Array.isArray(availableResponse.data) && availableResponse.data.length > 0) {
        const firstEditor = this.parseEditorRecord(availableResponse.data[0]);
        if (firstEditor?.type) {
          targets.push({
            type: firstEditor.type,
            label: this.getEditorLabel(firstEditor.type, firstEditor.name),
          });
        }
      }

      this.editorTargets.set(targets);
      this.hasLoadedEditorTargets = true;
    } finally {
      this.isLoadingEditors.set(false);
    }
  }

  private parseEditorRecord(value: unknown): { type: string; name?: string } | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const record = value as Record<string, unknown>;
    const type = record['type'];
    if (typeof type !== 'string' || type.length === 0) {
      return null;
    }

    return {
      type,
      name: typeof record['name'] === 'string' ? record['name'] : undefined,
    };
  }

  private getEditorLabel(type: string, name?: string): string {
    if (name) {
      return name;
    }

    switch (type) {
      case 'vscode':
        return 'VS Code';
      case 'vscode-insiders':
        return 'VS Code Insiders';
      case 'cursor':
        return 'Cursor';
      case 'sublime':
        return 'Sublime Text';
      case 'notepad++':
        return 'Notepad++';
      default:
        return type.charAt(0).toUpperCase() + type.slice(1);
    }
  }
}
