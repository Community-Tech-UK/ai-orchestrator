/**
 * Instance Header Component - Header with status, badges, and actions
 */

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
  OnInit,
  ChangeDetectionStrategy
} from '@angular/core';
import { StatusIndicatorComponent } from '../instance-list/status-indicator.component';
import { RecentDirectoriesDropdownComponent } from '../../shared/components/recent-directories-dropdown/recent-directories-dropdown.component';
import { ContextBarComponent } from './context-bar.component';
import { CrossModelReviewIndicatorComponent } from './cross-model-review-indicator.component';
import { SkillStore } from '../../core/state/skill.store';
import { HookStore } from '../../core/state/hook.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import type { ContextUsage, Instance } from '../../core/state/instance.store';
import { getModelShortName } from '../../../../shared/types/provider.types';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';
import { resolveEffectiveInstanceTitle } from '../../../../shared/types/history.types';

interface EditorMenuItem {
  type: string;
  label: string;
}

@Component({
  selector: 'app-instance-header',
  standalone: true,
  imports: [StatusIndicatorComponent, RecentDirectoriesDropdownComponent, ContextBarComponent, CrossModelReviewIndicatorComponent],
  templateUrl: './instance-header.component.html',
  styleUrl: './instance-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstanceHeaderComponent implements OnInit {
  private skillStore = inject(SkillStore);
  private hookStore = inject(HookStore);
  private fileIpc = inject(FileIpcService);
  private electronIpc = inject(ElectronIpcService);
  private readonly remoteNodeStore = inject(RemoteNodeStore);

  private nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  instance = input.required<Instance>();
  isEditingName = input(false);
  isChangingMode = input(false);
  isTogglingYolo = input(false);
  showModelDropdown = input(false);
  currentModel = input<string | undefined>(undefined);
  models = input<ModelDisplayInfo[]>([]);
  contextUsage = input<ContextUsage | null>(null);
  canShowFileExplorer = input(false);
  isFileExplorerOpen = input(false);
  canShowSourceControl = input(false);
  isSourceControlOpen = input(false);
  sourceControlChangeCount = input(0);

  // Effective display title — delegates to the shared resolver so the header
  // stays in sync with the workspace rail list. See
  // `resolveEffectiveInstanceTitle` in shared/types/history.types.ts.
  readonly displayTitle = computed(() =>
    resolveEffectiveInstanceTitle(this.instance())
  );

  // Skills and hooks counts
  activeSkillCount = computed(() => this.skillStore.activeSkillCount());
  enabledHookCount = computed(() => this.hookStore.enabledHookCount());
  showOpenMenu = signal(false);
  editorTargets = signal<EditorMenuItem[]>([]);
  isLoadingEditors = signal(false);
  private hasLoadedEditorTargets = false;

  readonly isStartingOrRecovering = computed(() => {
    const status = this.instance().status;
    return status === 'initializing'
      || status === 'respawning'
      || status === 'interrupting'
      || status === 'cancelling'
      || status === 'interrupt-escalating';
  });

  readonly isRuntimeLocked = computed(() => {
    const status = this.instance().status;
    return status === 'busy' || this.isStartingOrRecovering();
  });

  // Tooltips for badges
  activeSkillsTooltip = computed(() => {
    const skills = this.skillStore.getActiveSkillBundles();
    if (skills.length === 0) return '';
    return 'Active skills:\n' + skills.map(s => `• ${s.metadata.name}`).join('\n');
  });

  enabledHooksTooltip = computed(() => {
    const hooks = this.hookStore.enabledHooks();
    if (hooks.length === 0) return '';
    return 'Enabled hooks:\n' + hooks.map(h => `• ${h.name}`).join('\n');
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

  readonly remoteNodeName = computed(() =>
    this.remoteNode()?.name ?? this.remoteNodeId()?.slice(0, 8) ?? '',
  );

  readonly remoteNodeDisconnected = computed(() => {
    const node = this.remoteNode();
    return this.isRemote() && (!node || (node.status !== 'connected' && node.status !== 'degraded'));
  });

  readonly remoteNodeTooltip = computed(() => {
    const node = this.remoteNode();
    if (!node) return `Node ${this.remoteNodeId()?.slice(0, 8)} — no longer registered`;
    const caps = node.capabilities;
    const platform = caps.platform === 'win32' ? 'Windows' : caps.platform === 'darwin' ? 'macOS' : 'Linux';
    const lines = [
      node.name,
      `Platform: ${platform} (${caps.arch})`,
      `Latency: ${node.latencyMs !== null && node.latencyMs !== undefined ? node.latencyMs + 'ms' : 'unknown'}`,
      `CPU: ${caps.cpuCores} cores`,
      `Memory: ${caps.availableMemoryMB !== null && caps.availableMemoryMB !== undefined ? (caps.availableMemoryMB / 1024).toFixed(1) : '?'} / ${(caps.totalMemoryMB / 1024).toFixed(1)} GB`,
    ];
    if (caps.gpuName) lines.push(`GPU: ${caps.gpuName}${caps.gpuMemoryMB ? ' (' + (caps.gpuMemoryMB / 1024).toFixed(0) + ' GB)' : ''}`);
    lines.push(`CLIs: ${caps.supportedClis.join(', ')}`);
    lines.push(`Sessions: ${node.activeInstances} active`);
    lines.push(`Status: ${node.status}`);
    return lines.join('\n');
  });

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

  ngOnInit(): void {
    // Load skills and hooks on init
    this.skillStore.discoverSkills();
    this.hookStore.loadHooks();
  }

  // Actions. Restart/terminate/create-child have moved to the session
  // right-click menu in the instance list, so they're no longer surfaced
  // here; the corresponding outputs were removed with their buttons.
  startEditName = output<void>();
  cancelEditName = output<void>();
  saveName = output<string>();
  cycleAgentMode = output<void>();
  toggleYolo = output<void>();
  selectFolder = output<string>();
  interrupt = output<void>();
  toggleModelDropdown = output<void>();
  closeModelDropdown = output<void>();
  selectModel = output<string>();
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

  providerDisplayName = computed(() => {
    return this.getProviderDisplayName(this.instance().provider);
  });

  providerColor = computed(() => {
    return this.getProviderColor(this.instance().provider);
  });

  availableModels = computed((): ModelDisplayInfo[] => {
    return this.models();
  });

  currentModelId = computed(() => {
    return this.currentModel() || this.availableModels()[0]?.id || '';
  });

  currentModelDisplayName = computed(() => {
    const modelId = this.currentModelId();
    // First try dynamic models list
    const models = this.availableModels();
    const match = models.find(m => m.id === modelId);
    if (match) return match.name;
    // Fall back to static lookup
    const provider = this.instance().provider;
    return getModelShortName(modelId, provider);
  });

  modelBtnBorderColor = computed(() => {
    const color = this.getProviderColor(this.instance().provider);
    return color + '4D'; // 30% opacity hex
  });

  modelBtnBgColor = computed(() => {
    const color = this.getProviderColor(this.instance().provider);
    return color + '26'; // 15% opacity hex
  });

  agentModeIcon = computed(() => {
    return this.getAgentModeIcon(this.instance().agentId);
  });

  agentModeName = computed(() => {
    return this.getAgentModeName(this.instance().agentId);
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

  getProviderColor(provider: string): string {
    switch (provider) {
      case 'claude':
        return '#D97706';
      case 'codex':
        return '#10A37F';
      case 'gemini':
        return '#4285F4';
      case 'ollama':
        return '#888888';
      case 'copilot':
        return '#A855F7';
      case 'cursor':
        return '#000000';
      default:
        return '#888888';
    }
  }

  getAgentModeIcon(agentId?: string): string {
    switch (agentId) {
      case 'plan':
        return '🗺️';
      case 'review':
        return '👁️';
      default:
        return '🔨';
    }
  }

  getAgentModeName(agentId?: string): string {
    switch (agentId) {
      case 'plan':
        return 'Plan';
      case 'review':
        return 'Review';
      default:
        return 'Build';
    }
  }

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

  /**
   * Open the system terminal at this instance's working directory.
   * Surfaced as both a dedicated icon button in the header (mirroring the
   * "Open Terminal" button in the Codex desktop app) and as an item in the
   * Open dropdown for keyboard/menu access.
   */
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
