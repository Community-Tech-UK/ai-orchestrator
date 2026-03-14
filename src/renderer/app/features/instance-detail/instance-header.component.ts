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
  signal,
  viewChild,
  ElementRef,
  OnInit,
  ChangeDetectionStrategy
} from '@angular/core';
import { StatusIndicatorComponent } from '../instance-list/status-indicator.component';
import { RecentDirectoriesDropdownComponent } from '../../shared/components/recent-directories-dropdown/recent-directories-dropdown.component';
import { ContextBarComponent } from './context-bar.component';
import { SkillStore } from '../../core/state/skill.store';
import { HookStore } from '../../core/state/hook.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import type { ContextUsage, Instance } from '../../core/state/instance.store';
import { getModelShortName } from '../../../../shared/types/provider.types';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';

interface EditorMenuItem {
  type: string;
  label: string;
}

@Component({
  selector: 'app-instance-header',
  standalone: true,
  imports: [StatusIndicatorComponent, RecentDirectoriesDropdownComponent, ContextBarComponent],
  template: `
    <div class="detail-header">
      <div class="header-top">
        <div class="instance-identity">
          <div class="name-row">
            <app-status-indicator [status]="instance().status" />
            @if (isEditingName()) {
              <input
                type="text"
                class="name-input"
                [value]="instance().displayName"
                (keydown.enter)="onSaveName($event)"
                (keydown.escape)="cancelEditName.emit()"
                (blur)="onSaveName($event)"
                #nameInput
              />
            } @else {
              <h2
                class="instance-name editable"
                [title]="instance().displayName"
                role="button"
                tabindex="0"
                (dblclick)="startEditName.emit()"
                (keydown.enter)="startEditName.emit()"
                (keydown.space)="startEditName.emit()"
              >
                <span class="instance-name-text">{{ instance().displayName }}</span>
                <span class="edit-icon">rename</span>
              </h2>
            }
          </div>
        </div>

        <div class="header-actions">
          @if (instance().status === 'busy') {
            <button
              class="btn-action btn-interrupt"
              title="Interrupt Claude (Esc)"
              (click)="interrupt.emit()"
            >
              ⏸ Interrupt
            </button>
          }
          @if (canShowFileExplorer()) {
            <button
              class="btn-action btn-icon"
              [class.active]="isFileExplorerOpen()"
              [title]="isFileExplorerOpen() ? 'Hide file browser' : 'Show file browser'"
              (click)="toggleFileExplorer.emit()"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H10l2 2h7.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z"/>
              </svg>
            </button>
          }
          <div class="open-menu-shell">
            <button
              class="btn-action btn-open"
              title="Open workspace"
              [disabled]="!instance().workingDirectory"
              (click)="onToggleOpenMenu($event)"
            >
              <span>Open</span>
              <span class="open-caret">▾</span>
            </button>
            @if (showOpenMenu()) {
              <div class="open-menu">
                <button
                  class="open-menu-item"
                  (click)="openInPreferredEditor()"
                  [disabled]="isLoadingEditors()"
                >
                  Open in {{ preferredEditorLabel() }}
                </button>
                <button
                  class="open-menu-item"
                  (click)="openInSystemFileManager()"
                >
                  Open in {{ systemFolderLabel() }}
                </button>
              </div>
              <button
                type="button"
                class="open-menu-backdrop"
                aria-label="Close open menu"
                (click)="showOpenMenu.set(false)"
              ></button>
            }
          </div>
          <button
            class="btn-action"
            title="Restart instance"
            (click)="restart.emit()"
            [disabled]="instance().status === 'initializing' || instance().status === 'respawning'"
          >
            ↻ Restart
          </button>
          <button
            class="btn-action btn-danger"
            title="Terminate instance"
            (click)="terminate.emit()"
          >
            × Terminate
          </button>
          <button
            class="btn-action btn-primary"
            title="Create child instance"
            (click)="createChild.emit()"
          >
            + Child
          </button>
        </div>
      </div>

      <div class="header-bottom">
        <div class="instance-meta">
          <span
            class="provider-badge"
            [style.background-color]="providerColor()"
            [title]="'Provider: ' + providerDisplayName()"
          >
            {{ providerDisplayName() }}
          </span>
          @if (availableModels().length > 0) {
            <div class="model-selector-inline">
              <button
                class="model-btn"
                [style.border-color]="modelBtnBorderColor()"
                [style.background]="modelBtnBgColor()"
                [style.color]="providerColor()"
                [disabled]="instance().status === 'busy' || instance().status === 'respawning'"
                (click)="$event.stopPropagation(); toggleModelDropdown.emit()"
                [title]="'Model: ' + currentModelId()"
              >
                {{ currentModelDisplayName() }}
                <span class="dropdown-caret">▼</span>
              </button>
              @if (showModelDropdown()) {
                <div class="model-dropdown">
                  @for (model of availableModels(); track model.id) {
                    <button
                      class="model-option"
                      [class.selected]="model.id === currentModelId()"
                      (click)="selectModel.emit(model.id)"
                    >
                      <span class="model-name">{{ model.name }}</span>
                      <span class="model-tier" [class]="'tier-' + model.tier">{{ model.tier }}</span>
                      @if (model.id === currentModelId()) {
                        <span class="check">✓</span>
                      }
                    </button>
                  }
                </div>
              }
            </div>
            @if (showModelDropdown()) {
              <button
                type="button"
                class="model-backdrop"
                aria-label="Close model menu"
                (click)="closeModelDropdown.emit()"
              ></button>
            }
          }
          <button
            class="mode-badge"
            [class.plan]="instance().agentId === 'plan'"
            [class.review]="instance().agentId === 'review'"
            [disabled]="isChangingMode() || instance().status === 'busy' || instance().status === 'respawning'"
            [title]="
              instance().status === 'busy' || instance().status === 'respawning'
                ? 'Cannot change mode while instance is busy'
                : 'Click to change mode'
            "
            (click)="cycleAgentMode.emit()"
          >
            {{ agentModeIcon() }}
            {{ agentModeName() }}
          </button>
          <app-recent-directories-dropdown
            [currentPath]="instance().workingDirectory || ''"
            (folderSelected)="selectFolder.emit($event)"
          />
          <button
            class="yolo-badge"
            [class.active]="instance().yoloMode"
            [disabled]="isTogglingYolo() || instance().status === 'busy' || instance().status === 'respawning'"
            [title]="
              instance().status === 'busy' || instance().status === 'respawning'
                ? 'Cannot toggle YOLO mode while instance is busy'
                : instance().yoloMode
                  ? 'YOLO Mode: Auto-approve all tool calls without prompting. Click to disable'
                  : 'YOLO Mode: Requires manual approval for tool calls. Click to enable auto-approve'
            "
            (click)="toggleYolo.emit()"
          >
            ⚡ YOLO {{ instance().yoloMode ? 'ON' : 'OFF' }}
          </button>
          @if (activeSkillCount() > 0) {
            <span class="skills-badge" [title]="activeSkillsTooltip()">
              🧩 {{ activeSkillCount() }} skill{{ activeSkillCount() > 1 ? 's' : '' }}
            </span>
          }
          @if (enabledHookCount() > 0) {
            <span class="hooks-badge" [title]="enabledHooksTooltip()">
              🪝 {{ enabledHookCount() }} hook{{ enabledHookCount() > 1 ? 's' : '' }}
            </span>
          }
        </div>

        @if (contextUsage(); as usage) {
          <div class="header-context">
            <app-context-bar [usage]="usage" [showDetails]="true" [showCost]="false" />
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .detail-header {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 0 2px 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }

      .header-top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
      }

      .header-bottom {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        flex-wrap: wrap;
      }

      .instance-identity {
        flex: 1;
        min-width: 0;
      }

      .name-row {
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }

      .instance-name {
        font-family: var(--font-display);
        font-size: clamp(16px, 1.75vw, 21px);
        font-weight: 600;
        letter-spacing: -0.02em;
        margin: 0;
        color: var(--text-primary);

        &.editable {
          cursor: pointer;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: start;
          gap: var(--spacing-xs);
          padding: 2px 4px;
          border-radius: 10px;
          transition: background var(--transition-fast);
          min-width: 0;
          flex: 1;

          &:hover {
            background: rgba(255, 255, 255, 0.02);
          }

          .edit-icon {
            opacity: 0;
            font-family: var(--font-mono);
            font-size: 8px;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            transition: opacity var(--transition-fast);
            color: var(--text-muted);
          }

          &:hover .edit-icon {
            opacity: 0.58;
          }
        }
      }

      .instance-name-text {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
        min-width: 0;
        line-height: 1.14;
        overflow-wrap: anywhere;
      }

      .name-input {
        font-family: var(--font-display);
        font-size: 18px;
        font-weight: 600;
        letter-spacing: -0.02em;
        padding: 4px 10px;
        border: 2px solid var(--primary-color);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.03);
        color: var(--text-primary);
        outline: none;
        min-width: 220px;
        box-shadow: 0 0 0 4px rgba(var(--primary-rgb), 0.12);
      }

      .instance-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        min-width: 0;
      }

      .header-context {
        flex: 1 1 280px;
        min-width: min(100%, 280px);
        max-width: 440px;
        margin-left: auto;
      }

      .provider-badge {
        padding: 4px 8px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 999px;
        font-family: var(--font-mono);
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: white;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
      }

      .model-selector-inline {
        position: relative;
        display: inline-block;
      }

      .model-btn,
      .mode-badge,
      .yolo-badge,
      .skills-badge,
      .hooks-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border-radius: 999px;
        font-family: var(--font-mono);
        font-size: 9px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .model-btn {
        border: 1px solid;
        cursor: pointer;
        transition: filter var(--transition-fast), opacity var(--transition-fast);
      }

      .model-btn:hover:not(:disabled) {
        filter: brightness(1.12);
      }

      .model-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .dropdown-caret {
        font-size: 8px;
        opacity: 0.65;
      }

      .model-dropdown {
        position: absolute;
        top: 100%;
        left: 0;
        margin-top: 8px;
        min-width: 180px;
        background: rgba(11, 16, 15, 0.96);
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 16px;
        box-shadow: 0 18px 36px rgba(0, 0, 0, 0.28);
        z-index: 1000;
        max-height: 300px;
        overflow-y: auto;
        backdrop-filter: blur(18px);
      }

      .model-option {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        padding: 8px 12px;
        border: none;
        background: transparent;
        color: var(--text-primary);
        font-family: var(--font-mono);
        font-size: 11px;
        cursor: pointer;
        text-align: left;
        transition: background var(--transition-fast);
      }

      .model-option:hover {
        background: var(--bg-tertiary);
      }

      .model-option.selected {
        background: var(--bg-tertiary);
        color: var(--primary-color);
      }

      .model-option .check {
        color: var(--primary-color);
        font-size: 12px;
      }

      .model-name {
        flex: 1;
      }

      .model-tier {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 1px 5px;
        border-radius: 4px;
        margin-right: 6px;
        opacity: 0.7;
      }

      .tier-powerful {
        color: #f59e0b;
      }

      .tier-balanced {
        color: #10b981;
      }

      .tier-fast {
        color: #60a5fa;
      }

      .model-backdrop {
        position: fixed;
        inset: 0;
        z-index: 999;
        background: transparent;
        border: none;
      }

      .mode-badge {
        border: 1px solid rgba(255, 255, 255, 0.06);
        background: rgba(255, 255, 255, 0.025);
        color: var(--text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          color: var(--text-primary);
          border-color: rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.045);
        }

        &.plan {
          background: rgba(97, 120, 163, 0.12);
          color: #d6ddf6;
        }

        &.review {
          background: rgba(var(--primary-rgb), 0.1);
          color: var(--primary-color);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          transform: none;
        }
      }

      .yolo-badge {
        border: 1px solid rgba(255, 255, 255, 0.06);
        background: rgba(255, 255, 255, 0.025);
        color: var(--text-muted);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          color: var(--text-primary);
          border-color: rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.045);
        }

        &.active {
          background: rgba(var(--primary-rgb), 0.1);
          border-color: rgba(var(--primary-rgb), 0.22);
          color: var(--primary-color);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .skills-badge,
      .hooks-badge {
        border: 1px solid rgba(255, 255, 255, 0.06);
        background: rgba(255, 255, 255, 0.025);
      }

      .skills-badge {
        color: #c8d4ff;
      }

      .hooks-badge {
        color: var(--primary-color);
      }

      .header-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        justify-content: flex-end;
        position: relative;
      }

      .btn-action {
        padding: 7px 11px;
        border-radius: 999px;
        font-family: var(--font-display);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.01em;
        background: rgba(255, 255, 255, 0.025);
        border: 1px solid rgba(255, 255, 255, 0.06);
        color: var(--text-secondary);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.05);
          border-color: rgba(255, 255, 255, 0.1);
          color: var(--text-primary);
        }

        &:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
      }

      .btn-action.btn-icon {
        width: 34px;
        height: 34px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .btn-action.btn-icon.active {
        color: var(--primary-color);
        border-color: rgba(var(--primary-rgb), 0.22);
        background: rgba(var(--primary-rgb), 0.08);
      }

      .open-menu-shell {
        position: relative;
      }

      .btn-open {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .open-caret {
        font-size: 10px;
        opacity: 0.72;
      }

      .open-menu {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        min-width: 180px;
        padding: 6px;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(11, 16, 15, 0.96);
        box-shadow: 0 18px 36px rgba(0, 0, 0, 0.28);
        backdrop-filter: blur(18px);
        z-index: 1000;
      }

      .open-menu-item {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 9px 11px;
        border: none;
        border-radius: 12px;
        background: transparent;
        color: var(--text-primary);
        font-family: var(--font-display);
        font-size: 12px;
        font-weight: 500;
        text-align: left;
        cursor: pointer;
        transition: background var(--transition-fast), color var(--transition-fast);
      }

      .open-menu-item:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.05);
      }

      .open-menu-item:disabled {
        opacity: 0.5;
        cursor: progress;
      }

      .open-menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 999;
        background: transparent;
        border: none;
      }

      .btn-danger {
        color: var(--error-color);
        border-color: rgba(var(--error-rgb), 0.18);

        &:hover:not(:disabled) {
          background: rgba(var(--error-rgb), 0.1);
          border-color: rgba(var(--error-rgb), 0.26);
        }
      }

      .btn-interrupt {
        background: rgba(var(--primary-rgb), 0.12);
        color: var(--primary-color);
        border-color: rgba(var(--primary-rgb), 0.18);

        &:hover:not(:disabled) {
          background: rgba(var(--primary-rgb), 0.18);
          border-color: rgba(var(--primary-rgb), 0.24);
          color: var(--primary-hover);
        }
      }

      .btn-primary {
        background: linear-gradient(
          135deg,
          rgba(var(--primary-rgb), 0.9) 0%,
          var(--primary-hover) 100%
        );
        border: none;
        color: var(--bg-primary);
        box-shadow: 0 10px 22px rgba(var(--primary-rgb), 0.14);

        &:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 14px 26px rgba(var(--primary-rgb), 0.18);
        }
      }

      @media (max-width: 960px) {
        .header-top,
        .header-bottom {
          flex-direction: column;
          align-items: stretch;
        }

        .header-actions {
          justify-content: flex-start;
        }

        .header-context {
          margin-left: 0;
          max-width: none;
        }
      }

      @media (max-width: 640px) {
        .detail-header {
          gap: 8px;
          padding-bottom: 6px;
        }

        .name-row {
          gap: 8px;
        }

        .instance-name {
          font-size: 16px;
        }
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InstanceHeaderComponent implements OnInit {
  private skillStore = inject(SkillStore);
  private hookStore = inject(HookStore);
  private fileIpc = inject(FileIpcService);
  private electronIpc = inject(ElectronIpcService);

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

  // Skills and hooks counts
  activeSkillCount = computed(() => this.skillStore.activeSkillCount());
  enabledHookCount = computed(() => this.hookStore.enabledHookCount());
  showOpenMenu = signal(false);
  editorTargets = signal<EditorMenuItem[]>([]);
  isLoadingEditors = signal(false);
  private hasLoadedEditorTargets = false;

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

  constructor() {
    // Focus the name input whenever editing starts
    effect(() => {
      if (this.isEditingName()) {
        const input = this.nameInput()?.nativeElement;
        if (input) {
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

  // Actions
  startEditName = output<void>();
  cancelEditName = output<void>();
  saveName = output<string>();
  cycleAgentMode = output<void>();
  toggleYolo = output<void>();
  selectFolder = output<string>();
  interrupt = output<void>();
  restart = output<void>();
  terminate = output<void>();
  createChild = output<void>();
  toggleModelDropdown = output<void>();
  closeModelDropdown = output<void>();
  selectModel = output<string>();
  toggleFileExplorer = output<void>();

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
