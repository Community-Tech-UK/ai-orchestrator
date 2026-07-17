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
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import { DEFAULT_INSTANCE_PROVIDERS, PROVIDER_MENU_LABELS } from '../models/provider-menu.constants';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';
import { SkillStore } from '../../core/state/skill.store';
import { HookStore } from '../../core/state/hook.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { isRemoteNodeOnline } from '../../core/state/remote-node-connectivity';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import type { ContextUsage, Instance } from '../../core/state/instance.store';
import { getModelShortName } from '../../../../shared/types/provider.types';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';
import { resolveEffectiveInstanceTitle } from '../../../../shared/types/history.types';
import type { InstanceRuntimeSummary } from '../../../../shared/types/local-model-runtime.types';

interface EditorMenuItem {
  type: string;
  label: string;
}

@Component({
  selector: 'app-instance-header',
  standalone: true,
  imports: [StatusIndicatorComponent, RecentDirectoriesDropdownComponent, ContextBarComponent, CrossModelReviewIndicatorComponent, CompactModelPickerComponent],
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
  isTogglingFastMode = input(false);
  currentModel = input<string | undefined>(undefined);
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
  /** Fast mode is only meaningful for Claude (Opus) and Codex (priority tier). */
  readonly supportsFastMode = computed(() => {
    const provider = this.instance().provider;
    return provider === 'claude' || provider === 'codex';
  });
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

  readonly waitReasonLabel = computed(() => {
    const wr = this.instance().waitReason;
    if (!wr) return null;
    switch (wr.kind) {
      case 'respawning':
        return wr.strategy === 'native-resume' ? 'Resuming session…' : 'Restarting session…';
      case 'interrupt-ack':
        return 'Waiting for interrupt…';
      case 'backoff': {
        const secsLeft = Math.max(0, Math.round((wr.retryAt - Date.now()) / 1000));
        return secsLeft > 0 ? `Backing off — retry in ${secsLeft}s` : 'Retrying…';
      }
      // 'quota-park' renders as a banner above the composer (input-panel), not here.
      case 'quota-park':
        return null;
      case 'provider-slot':
        return `Waiting for ${wr.provider} slot…`;
      case 'resume-proof':
        return 'Verifying session resume…';
      case 'remote-heartbeat':
        return 'Remote worker stale…';
      case 'mutex':
        return `Waiting for lock (${wr.operation})…`;
      case 'terminating':
        return wr.force ? 'Force terminating…' : 'Terminating…';
      default:
        return null;
    }
  });

  readonly waitReasonDetail = computed(() => {
    const wr = this.instance().waitReason;
    if (!wr) return '';
    switch (wr.kind) {
      case 'respawning':
        return `Strategy: ${wr.strategy}`;
      case 'interrupt-ack':
        return `Attempt ${wr.attempt}`;
      case 'backoff':
        return `Attempt ${wr.attempt}, retry at ${new Date(wr.retryAt).toLocaleTimeString()}`;
      case 'quota-park':
        return `Provider: ${wr.provider}, resumes at ${new Date(wr.resumeAt).toLocaleTimeString()}`;
      case 'provider-slot':
        return `Provider: ${wr.provider}`;
      case 'resume-proof':
        return wr.sessionId ? `Session: ${wr.sessionId.slice(0, 8)}…` : `Provider: ${wr.provider}`;
      case 'remote-heartbeat':
        return `Node: ${wr.nodeId}, stale for ${Math.round(wr.staleForMs / 1000)}s`;
      case 'mutex':
        return wr.owner ? `Owner: ${wr.owner}` : wr.operation;
      case 'terminating':
        return wr.force ? 'Force kill' : 'Graceful shutdown';
      default:
        return '';
    }
  });

  readonly isRuntimeLocked = computed(() => {
    const status = this.instance().status;
    return status === 'busy' || this.isStartingOrRecovering();
  });

  /**
   * A YOLO change is queued (requested while busy) and will apply on the next
   * idle. Drives the ⚡ button's pending affordance.
   */
  readonly yoloPending = computed(() => {
    const inst = this.instance();
    return inst.pendingYoloMode !== undefined && inst.pendingYoloMode !== inst.yoloMode;
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
    return this.isRemote() && (!node || !isRemoteNodeOnline(node));
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
  toggleFastMode = output<void>();
  selectFolder = output<string>();
  interrupt = output<void>();
  /** Provider/model/effort pick committed in the header's compact picker. */
  modelSelectionChange = output<PendingSelection>();
  /** Cancel a model change that was queued while the instance was busy. */
  cancelDesiredRuntime = output<void>();
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

  readonly runtimeSummary = computed(() => this.instance().runtimeSummary);
  readonly isLocalModelRuntime = computed(() => this.runtimeSummary()?.kind === 'local-model');

  providerDisplayName = computed(() =>
    resolveHeaderProviderDisplayName(this.instance().provider, this.runtimeSummary()),
  );

  providerColor = computed(() => {
    return this.getProviderColor(this.instance().provider, this.runtimeSummary());
  });

  currentModelId = computed(() => {
    const runtimeSummary = this.runtimeSummary();
    if (runtimeSummary?.kind === 'local-model') {
      return runtimeSummary.modelId || this.currentModel() || '';
    }
    return this.currentModel() || '';
  });

  currentModelDisplayName = computed(() => {
    return resolveHeaderModelDisplayName({
      runtimeSummary: this.runtimeSummary(),
      currentModel: this.currentModel(),
      availableModels: [],
      provider: this.instance().provider,
    });
  });

  /** Providers offered by the header picker (same list as the composer). */
  readonly pickerProviders = DEFAULT_INSTANCE_PROVIDERS;

  /**
   * Current provider/model/effort mapped to the compact picker's selection.
   * `ollama` collapses to `claude` because the picker has no Ollama tab.
   */
  readonly pickerSelection = computed<PendingSelection>(() => {
    const inst = this.instance();
    const provider = (inst.provider === 'ollama' ? 'claude' : inst.provider) as PickerProvider;
    return {
      provider,
      model: this.currentModel() ?? null,
      reasoning: inst.reasoningEffort ?? null,
    };
  });

  /**
   * The backend queues changes requested while busy, so the picker only
   * disables in terminal states where no future idle will apply them.
   */
  readonly pickerDisabledReason = computed<string | null>(() => {
    const status = this.instance().status;
    if (status === 'terminated' || status === 'failed' || status === 'hibernated') {
      return 'Model changes require a live session.';
    }
    return null;
  });

  /** Compact "Provider · model" label for the queued-change chip. */
  readonly desiredRuntimeLabel = computed<string | null>(() => {
    const pending = this.instance().desiredRuntime;
    if (!pending) return null;
    // A queued change that is ONLY a yolo flip must not render a misleading
    // "Provider · default model" chip — the pending-yolo indicator covers it.
    const inst = this.instance();
    const isYoloOnly =
      pending.yoloMode !== undefined
      && pending.model === undefined
      && pending.modelRuntimeTarget === undefined
      && pending.reasoningEffort === undefined
      && (!pending.provider || pending.provider === inst.provider);
    if (isYoloOnly) return null;
    const providerLabel = pending.provider
      ? PROVIDER_MENU_LABELS[pending.provider as PickerProvider] ?? pending.provider
      : null;
    if (pending.modelRuntimeTarget?.kind === 'local-model') {
      return `Local · ${pending.modelRuntimeTarget.modelId}`;
    }
    const model = pending.model ?? 'default model';
    return providerLabel ? `${providerLabel} · ${model}` : model;
  });

  modelBtnBorderColor = computed(() => {
    const color = this.getProviderColor(this.instance().provider, this.runtimeSummary());
    return color + '4D'; // 30% opacity hex
  });

  modelBtnBgColor = computed(() => {
    const color = this.getProviderColor(this.instance().provider, this.runtimeSummary());
    return color + '26'; // 15% opacity hex
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
      case 'grok':
        return 'Grok';
      default:
        return 'AI';
    }
  }

  getProviderColor(provider: string, runtimeSummary?: InstanceRuntimeSummary): string {
    if (runtimeSummary?.kind === 'local-model') {
      return '#14B8A6';
    }

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
        return '#B89A66';
      case 'cursor':
        // Cursor's mark is monochrome; use a light neutral so it stays visible
        // on dark surfaces rather than rendering black-on-black.
        return '#E5E7EB';
      case 'grok':
        return '#1DA1F2';
      default:
        return '#888888';
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

export function resolveHeaderProviderDisplayName(
  provider: string,
  runtimeSummary?: InstanceRuntimeSummary,
): string {
  if (runtimeSummary?.kind === 'local-model') {
    return 'Local Models';
  }

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
    case 'grok':
      return 'Grok';
    default:
      return 'AI';
  }
}

export function resolveHeaderModelDisplayName(options: {
  runtimeSummary?: InstanceRuntimeSummary;
  currentModel?: string;
  availableModels: ModelDisplayInfo[];
  provider: string;
}): string {
  if (options.runtimeSummary?.kind === 'local-model') {
    return options.runtimeSummary.label;
  }

  const modelId = options.currentModel || options.availableModels[0]?.id || '';
  const match = options.availableModels.find(m => m.id === modelId);
  if (match) return match.name;
  return getModelShortName(modelId, options.provider);
}
