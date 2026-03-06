/**
 * Ecosystem Settings Tab
 *
 * Browse and edit file-based extensibility surfaces:
 * - Slash commands (markdown)
 * - Custom agents (markdown)
 * - Local tools (CommonJS JS modules)
 * - Plugins (JS hooks)
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  OnDestroy
} from '@angular/core';
import { ElectronIpcService } from '../../core/services/ipc';
import { InstructionIpcService } from '../../core/services/ipc/instruction-ipc.service';
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import type { RecentDirectoriesOptions } from '../../../../shared/types/recent-directories.types';
import type {
  InstructionResolution,
  ResolvedInstructionSource,
} from '../../../../shared/types/instruction-source.types';

type EcosystemKind = 'command' | 'agent' | 'tool' | 'plugin';

interface EcosystemListResponse {
  workingDirectory: string;
  commands: {
    commands: {
      name: string;
      description: string;
      hint?: string;
      filePath?: string;
      model?: string;
      agent?: string;
      subtask?: boolean;
    }[];
    candidatesByName: Record<string, { filePath?: string; description?: string }[]>;
    scanDirs: string[];
  };
  agents: {
    agents: (
      | { source: 'built-in'; profile: { id: string; name: string; description: string; mode: string } }
      | { source: 'file'; filePath: string; profile: { id: string; name: string; description: string; mode: string } }
    )[];
    scanDirs: string[];
  };
  tools: {
    tools: { id: string; description: string; filePath: string }[];
    candidatesById: Record<string, { id: string; description: string; filePath: string }[]>;
    scanDirs: string[];
    errors: { filePath: string; error: string }[];
  };
  plugins: {
    plugins: { filePath: string; hookKeys: string[] }[];
    scanDirs: string[];
    errors: { filePath: string; error: string }[];
  };
}

interface EcosystemChangedEventPayload {
  workingDirectory?: string;
}

interface FileReadTextResponse {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

@Component({
  selector: 'app-ecosystem-settings-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ecosystem">
      <div class="topbar">
        <div class="dir">
          <div class="label">Working directory</div>
          <div class="controls">
            <select
              class="select"
              [value]="workingDirectory()"
              (change)="onSelectWorkingDirectory($event)"
            >
              @for (d of recentDirectories(); track d.path) {
                <option [value]="d.path">{{ d.path }}</option>
              }
            </select>
            <button class="btn" (click)="pickWorkingDirectory()">Choose…</button>
            <button class="btn" (click)="reload()" [disabled]="loading()">Reload</button>
          </div>
          @if (error()) {
            <div class="error">{{ error() }}</div>
          }
        </div>
      </div>

      <div class="instruction-panel">
        <div class="instruction-header">
          <div>
            <div class="instruction-eyebrow">Instructions</div>
            <div class="instruction-title">Resolved Instruction Stack</div>
          </div>
          <div class="instruction-actions">
            <button class="btn" (click)="reloadInstructions()" [disabled]="instructionLoading() || !workingDirectory()">
              Refresh
            </button>
            <button class="btn primary" (click)="generateInstructionDraft()" [disabled]="instructionLoading() || !workingDirectory()">
              Generate Draft
            </button>
            @if (instructionDraftPath()) {
              <button class="btn" (click)="saveInstructionDraft()" [disabled]="instructionSaving()">
                Save Draft
              </button>
            }
          </div>
        </div>

        @if (instructionError()) {
          <div class="error">{{ instructionError() }}</div>
        }

        @if (instructionResolution(); as resolution) {
          <div class="instruction-meta">
            <div class="instruction-pill">Project root: {{ resolution.projectRoot }}</div>
            <div class="instruction-pill">Applied: {{ appliedInstructionCount() }}</div>
            <div class="instruction-pill">Loaded: {{ loadedInstructionCount() }}</div>
          </div>

          @if (resolution.warnings.length > 0) {
            <div class="instruction-warnings">
              @for (warning of resolution.warnings; track warning) {
                <div class="warn">{{ warning }}</div>
              }
            </div>
          }

          <div class="instruction-grid">
            <div class="instruction-sources">
              <div class="instruction-subtitle">Sources</div>
              <div class="instruction-source-list">
                @for (source of resolution.sources; track source.path) {
                  <div class="instruction-source" [class.applied]="source.applied">
                    <div class="instruction-source-main">
                      <span class="instruction-source-state" [class.applied]="source.applied" [class.missing]="!source.loaded">
                        {{ instructionSourceState(source) }}
                      </span>
                      <span class="instruction-source-label">{{ source.label }}</span>
                    </div>
                    <div class="instruction-source-path">{{ source.path }}</div>
                    <div class="instruction-source-meta">
                      <span>{{ source.kind }}</span>
                      <span>{{ source.scope }}</span>
                      <span>priority {{ source.priority }}</span>
                    </div>
                    @if (source.matchPatterns?.length) {
                      <div class="instruction-source-detail">
                        applyTo: {{ source.matchPatterns!.join(', ') }}
                      </div>
                    }
                    @if (source.reason) {
                      <div class="instruction-source-detail muted">{{ source.reason }}</div>
                    }
                    @if (source.matchedPaths?.length) {
                      <div class="instruction-source-detail">
                        matched: {{ source.matchedPaths!.join(', ') }}
                      </div>
                    }
                  </div>
                }
              </div>
            </div>

            <div class="instruction-preview">
              <div class="instruction-subtitle">Merged Preview</div>
              @if (resolution.mergedContent) {
                <pre class="instruction-pre">{{ resolution.mergedContent }}</pre>
              } @else {
                <div class="placeholder small">No active instruction content resolved for this directory.</div>
              }
            </div>
          </div>
        }

        @if (instructionDraftPath()) {
          <div class="instruction-draft">
            <div class="instruction-subtitle">Migration Draft</div>
            <div class="instruction-draft-path">{{ instructionDraftPath() }}</div>
            <textarea
              class="editor"
              [value]="instructionDraftContent()"
              (input)="onInstructionDraftEdit($event)"
              spellcheck="false"
            ></textarea>
          </div>
        }
      </div>

      <div class="content">
        <div class="left">
          <div class="section">
            <div class="section-title">
              <span>Commands</span>
              <button class="mini-btn" (click)="createNew('command')">New</button>
            </div>
            <div class="list">
              @for (cmd of commands(); track cmd.name) {
                <button
                  class="item"
                  [class.active]="selectedKind() === 'command' && selectedKey() === cmd.name"
                  (click)="select('command', cmd.name, cmd.filePath || null)"
                  title="{{ cmd.filePath || '' }}"
                >
                  <div class="item-title">/{{ cmd.name }}</div>
                  <div class="item-sub">{{ cmd.description }}</div>
                </button>
              }
              @if (commands().length === 0) {
                <div class="empty">No file commands found</div>
              }
            </div>
          </div>

          <div class="section">
            <div class="section-title">
              <span>Agents</span>
              <button class="mini-btn" (click)="createNew('agent')">New</button>
            </div>
            <div class="list">
              @for (a of agents(); track a.profile.id) {
                <button
                  class="item"
                  [class.active]="selectedKind() === 'agent' && selectedKey() === a.profile.id"
                  (click)="select('agent', a.profile.id, a.source === 'file' ? a.filePath : null)"
                  title="{{ a.source === 'file' ? a.filePath : 'Built-in' }}"
                >
                  <div class="item-title">
                    {{ a.profile.name }}
                    <span class="pill" [class.builtin]="a.source === 'built-in'">{{
                      a.source === 'built-in' ? 'built-in' : 'file'
                    }}</span>
                  </div>
                  <div class="item-sub">{{ a.profile.description }}</div>
                </button>
              }
              @if (agents().length === 0) {
                <div class="empty">No agents found</div>
              }
            </div>
          </div>

          <div class="section">
            <div class="section-title">
              <span>Tools</span>
              <button class="mini-btn" (click)="createNew('tool')">New</button>
            </div>
            <div class="list">
              @for (t of tools(); track t.id) {
                <button
                  class="item"
                  [class.active]="selectedKind() === 'tool' && selectedKey() === t.id"
                  (click)="select('tool', t.id, t.filePath)"
                  title="{{ t.filePath }}"
                >
                  <div class="item-title">{{ t.id }}</div>
                  <div class="item-sub">{{ t.description }}</div>
                </button>
              }
              @if (tools().length === 0) {
                <div class="empty">No tools found</div>
              }
            </div>
          </div>

          <div class="section">
            <div class="section-title">
              <span>Plugins</span>
              <button class="mini-btn" (click)="createNew('plugin')">New</button>
            </div>
            <div class="list">
              @for (p of plugins(); track p.filePath) {
                <button
                  class="item"
                  [class.active]="selectedKind() === 'plugin' && selectedKey() === p.filePath"
                  (click)="select('plugin', p.filePath, p.filePath)"
                  title="{{ p.filePath }}"
                >
                  <div class="item-title">{{ basename(p.filePath) }}</div>
                  <div class="item-sub">
                    {{ p.hookKeys.length }} hooks
                  </div>
                </button>
              }
              @if (plugins().length === 0) {
                <div class="empty">No plugins found</div>
              }
            </div>
          </div>
        </div>

        <div class="right">
          @if (!selectedKind()) {
            <div class="placeholder">
              Select a command/agent/tool/plugin to inspect and edit.
            </div>
          } @else {
            <div class="detail">
              <div class="detail-header">
                <div class="detail-title">
                  {{ selectedKind() }}: {{ selectedKey() }}
                </div>
                <div class="detail-actions">
                  @if (selectedFilePath()) {
                    <button class="btn" (click)="openPath(selectedFilePath()!)">Open</button>
                    <button class="btn" (click)="openContainingFolder(selectedFilePath()!)">Open folder</button>
                    <button class="btn" (click)="loadSelectedFile()">Reload file</button>
                  }
                </div>
              </div>

              <div class="meta">
                <div class="row">
                  <span class="k">File</span>
                  <span class="v">{{ selectedFilePath() || 'N/A' }}</span>
                </div>

                @if (overrideFiles().length > 1) {
                  <div class="row">
                    <span class="k">Overrides</span>
                    <span class="v">
                      @for (f of overrideFiles(); track f) {
                        <button class="link" (click)="selectCandidateFile(f)">{{ f }}</button>
                      }
                    </span>
                  </div>
                }
              </div>

              @if (!selectedFilePath()) {
                <div class="placeholder small">
                  Built-in item or missing file path; nothing to edit.
                </div>
              } @else {
                @if (fileTruncated()) {
                  <div class="warn">File is large; editor loaded a truncated preview.</div>
                }

                <textarea
                  class="editor"
                  [value]="fileContent()"
                  (input)="onEdit($event)"
                  spellcheck="false"
                ></textarea>

                <div class="editor-actions">
                  <button class="btn primary" (click)="saveFile()" [disabled]="saving()">
                    Save
                  </button>
                  <button class="btn" (click)="reload()" [disabled]="loading()">
                    Reload list
                  </button>
                </div>
              }

              <div class="scan">
                <div class="scan-title">Scan directories (in order)</div>
                <div class="scan-list">
                  @for (d of scanDirsForSelectedKind(); track d) {
                    <div class="scan-item">{{ d }}</div>
                  }
                </div>
              </div>

              @if ((ecosystem()?.tools?.errors?.length || 0) > 0 || (ecosystem()?.plugins?.errors?.length || 0) > 0) {
                <div class="scan">
                  <div class="scan-title">Load Errors</div>
                  <div class="scan-list">
                    @for (e of (ecosystem()?.tools?.errors || []); track e.filePath) {
                      <div class="scan-item error-item">
                        <div class="err-path">{{ e.filePath }}</div>
                        <div class="err-msg">{{ e.error }}</div>
                      </div>
                    }
                    @for (e of (ecosystem()?.plugins?.errors || []); track e.filePath) {
                      <div class="scan-item error-item">
                        <div class="err-path">{{ e.filePath }}</div>
                        <div class="err-msg">{{ e.error }}</div>
                      </div>
                    }
                  </div>
                </div>
              }
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .ecosystem {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }

      .topbar {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--spacing-md);
      }

      .instruction-panel {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: 14px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        background: linear-gradient(
          180deg,
          rgba(var(--primary-rgb), 0.08) 0%,
          rgba(0, 0, 0, 0.08) 100%
        );
      }

      .instruction-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--spacing-md);
      }

      .instruction-eyebrow {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted);
      }

      .instruction-title {
        margin-top: 4px;
        font-family: var(--font-display);
        font-size: 16px;
        font-weight: 800;
        color: var(--text-primary);
      }

      .instruction-actions {
        display: flex;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .instruction-meta {
        display: flex;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
      }

      .instruction-pill {
        padding: 6px 10px;
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.18);
        font-size: 12px;
        color: var(--text-secondary);
      }

      .instruction-warnings {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .instruction-grid {
        display: grid;
        grid-template-columns: minmax(280px, 0.9fr) minmax(0, 1.4fr);
        gap: var(--spacing-md);
      }

      .instruction-sources,
      .instruction-preview,
      .instruction-draft {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .instruction-subtitle {
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted);
      }

      .instruction-source-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 320px;
        overflow: auto;
      }

      .instruction-source {
        padding: 10px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: var(--radius-md);
        background: rgba(0, 0, 0, 0.14);
      }

      .instruction-source.applied {
        border-color: rgba(var(--primary-rgb), 0.35);
        background: rgba(var(--primary-rgb), 0.09);
      }

      .instruction-source-main {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }

      .instruction-source-state {
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(245, 158, 11, 0.15);
        color: #fbbf24;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .instruction-source-state.applied {
        background: rgba(16, 185, 129, 0.18);
        color: #6ee7b7;
      }

      .instruction-source-state.missing {
        background: rgba(239, 68, 68, 0.15);
        color: #fca5a5;
      }

      .instruction-source-label {
        font-size: 13px;
        font-weight: 700;
        color: var(--text-primary);
      }

      .instruction-source-path,
      .instruction-draft-path {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
        font-size: 11px;
        color: var(--text-secondary);
        word-break: break-word;
      }

      .instruction-source-meta,
      .instruction-source-detail {
        margin-top: 4px;
        font-size: 11px;
        color: var(--text-muted);
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .instruction-source-detail.muted {
        color: var(--text-muted);
      }

      .instruction-pre {
        margin: 0;
        padding: 12px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: rgba(0, 0, 0, 0.18);
        color: var(--text-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
        max-height: 320px;
        overflow: auto;
      }

      .dir .label {
        font-size: 12px;
        color: var(--text-muted);
        margin-bottom: 6px;
      }

      .controls {
        display: flex;
        gap: var(--spacing-sm);
        align-items: center;
        flex-wrap: wrap;
      }

      .select {
        min-width: 360px;
        max-width: 100%;
        padding: 8px 10px;
        border: 1px solid var(--border-subtle);
        background: var(--bg-secondary);
        color: var(--text-primary);
        border-radius: var(--radius-md);
      }

      .btn {
        padding: 8px 12px;
        border: 1px solid var(--border-subtle);
        background: var(--bg-secondary);
        color: var(--text-primary);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: all var(--transition-fast);
      }

      .btn:hover:not(:disabled) {
        border-color: var(--primary-color);
        background: rgba(var(--primary-rgb), 0.08);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn.primary {
        border-color: transparent;
        background: linear-gradient(
          135deg,
          var(--primary-color) 0%,
          var(--primary-hover) 100%
        );
        color: var(--bg-primary);
      }

      .error {
        margin-top: 8px;
        font-size: 12px;
        color: var(--error-color);
      }

      .content {
        display: grid;
        grid-template-columns: 1fr 1.2fr;
        gap: var(--spacing-md);
        align-items: start;
      }

      .left,
      .right {
        background: var(--bg-secondary);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        overflow: hidden;
      }

      .section {
        border-bottom: 1px solid var(--border-subtle);
      }

      .section:last-child {
        border-bottom: none;
      }

      .section-title {
        padding: 10px 12px;
        font-family: var(--font-display);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted);
        background: var(--bg-tertiary);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .mini-btn {
        padding: 4px 8px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-subtle);
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 11px;
        letter-spacing: 0;
        text-transform: none;
      }

      .mini-btn:hover {
        border-color: var(--primary-color);
        color: var(--text-primary);
        background: rgba(var(--primary-rgb), 0.08);
      }

      .list {
        display: flex;
        flex-direction: column;
        max-height: 170px;
        overflow: auto;
      }

      .item {
        text-align: left;
        padding: 10px 12px;
        border: none;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        background: transparent;
        cursor: pointer;
      }

      .item:hover {
        background: rgba(var(--primary-rgb), 0.06);
      }

      .item.active {
        background: rgba(var(--primary-rgb), 0.12);
      }

      .item-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-family: var(--font-display);
        font-size: 13px;
        font-weight: 700;
        color: var(--text-primary);
      }

      .item-sub {
        margin-top: 2px;
        font-size: 12px;
        color: var(--text-muted);
        line-height: 1.35;
      }

      .pill {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--border-subtle);
        color: var(--text-muted);
      }

      .pill.builtin {
        color: #93c5fd;
        border-color: rgba(147, 197, 253, 0.35);
      }

      .empty {
        padding: 12px;
        font-size: 12px;
        color: var(--text-muted);
      }

      .placeholder {
        padding: 16px;
        color: var(--text-muted);
        font-size: 13px;
      }

      .placeholder.small {
        padding: 12px;
        font-size: 12px;
      }

      .detail {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: 12px;
      }

      .detail-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
      }

      .detail-title {
        font-family: var(--font-display);
        font-size: 14px;
        font-weight: 800;
      }

      .detail-actions {
        display: flex;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .meta {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: rgba(0, 0, 0, 0.12);
      }

      .row {
        display: grid;
        grid-template-columns: 80px 1fr;
        gap: 10px;
        align-items: start;
      }

      .k {
        font-size: 12px;
        color: var(--text-muted);
      }

      .v {
        font-size: 12px;
        color: var(--text-primary);
        word-break: break-word;
      }

      .link {
        display: inline-block;
        margin-right: 8px;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--primary-color);
        cursor: pointer;
        text-decoration: underline;
        font-size: 12px;
      }

      .warn {
        padding: 10px;
        border-radius: var(--radius-md);
        border: 1px solid rgba(245, 158, 11, 0.35);
        background: rgba(245, 158, 11, 0.08);
        color: #fbbf24;
        font-size: 12px;
      }

      .editor {
        width: 100%;
        height: 340px;
        resize: vertical;
        padding: 12px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: rgba(0, 0, 0, 0.2);
        color: var(--text-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          'Liberation Mono', 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.45;
      }

      .editor-actions {
        display: flex;
        gap: var(--spacing-sm);
        justify-content: flex-end;
      }

      .scan-title {
        font-size: 12px;
        color: var(--text-muted);
        margin-bottom: 6px;
      }

      .scan-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .scan-item {
        font-size: 12px;
        color: var(--text-secondary);
        padding: 6px 8px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: var(--radius-sm);
        background: rgba(0, 0, 0, 0.12);
        word-break: break-word;
      }

      .error-item {
        border-color: rgba(239, 68, 68, 0.25);
        background: rgba(239, 68, 68, 0.06);
        color: var(--text-primary);
      }

      .err-path {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
        font-size: 11px;
        color: var(--text-secondary);
      }

      .err-msg {
        margin-top: 4px;
        font-size: 12px;
        color: var(--error-color);
      }

      @media (max-width: 1100px) {
        .instruction-grid,
        .content {
          grid-template-columns: 1fr;
        }
      }
    `
  ]
})
export class EcosystemSettingsTabComponent implements OnDestroy {
  private ipc = inject(ElectronIpcService);
  private instructionIpc = inject(InstructionIpcService);
  private recentDirsIpc = inject(RecentDirectoriesIpcService);
  private settingsStore = inject(SettingsStore);

  recentDirectories = signal<{ path: string }[]>([]);
  workingDirectory = signal<string>('');

  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);

  ecosystem = signal<EcosystemListResponse | null>(null);

  selectedKind = signal<EcosystemKind | null>(null);
  selectedKey = signal<string | null>(null);
  selectedFilePath = signal<string | null>(null);

  fileContent = signal('');
  fileTruncated = signal(false);
  instructionResolution = signal<InstructionResolution | null>(null);
  instructionError = signal<string | null>(null);
  instructionLoading = signal(false);
  instructionDraftPath = signal('');
  instructionDraftContent = signal('');
  instructionSaving = signal(false);
  private unsubscribeChanged: (() => void) | null = null;
  private watchWorkingDirectory: string | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  commands = computed(() => this.ecosystem()?.commands.commands ?? []);
  agents = computed(() => this.ecosystem()?.agents.agents ?? []);
  tools = computed(() => this.ecosystem()?.tools.tools ?? []);
  plugins = computed(() => this.ecosystem()?.plugins.plugins ?? []);
  appliedInstructionCount = computed(
    () => this.instructionResolution()?.sources.filter((source) => source.loaded && source.applied).length ?? 0,
  );
  loadedInstructionCount = computed(
    () => this.instructionResolution()?.sources.filter((source) => source.loaded).length ?? 0,
  );

  constructor() {
    void this.loadRecentDirectories();

    effect(() => {
      const wd = this.workingDirectory();
      if (!wd) return;
      void this.setWatchDirectory(wd);
      void this.reload();
      void this.reloadInstructions();
    });

    this.unsubscribeChanged = this.ipc.getApi()?.onEcosystemChanged((payload: unknown) => {
      const wd = (payload as EcosystemChangedEventPayload | undefined)?.workingDirectory;
      if (!wd || wd !== this.workingDirectory()) return;
      // Debounce reloads to avoid thrashing during saves.
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        void this.reload();
      }, 300);
    }) ?? null;
  }

  ngOnDestroy(): void {
    try {
      if (this.unsubscribeChanged) this.unsubscribeChanged();
    } catch {
      // ignore
    }
    if (this.watchWorkingDirectory) {
      void this.ipc.getApi()?.ecosystemWatchStop({ workingDirectory: this.watchWorkingDirectory! });
    }
  }

  basename(p: string): string {
    const idx = p.lastIndexOf('/');
    if (idx >= 0) return p.slice(idx + 1);
    const jdx = p.lastIndexOf('\\');
    if (jdx >= 0) return p.slice(jdx + 1);
    return p;
  }

  private async loadRecentDirectories(): Promise<void> {
    const options: RecentDirectoriesOptions = { limit: 20 };
    const dirs = await this.recentDirsIpc.getDirectories(options);
    this.recentDirectories.set(dirs);

    const defaultDir = this.settingsStore.defaultWorkingDirectory();
    const initial =
      defaultDir ||
      dirs[0]?.path ||
      '';
    if (initial) this.workingDirectory.set(initial);
  }

  onSelectWorkingDirectory(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.workingDirectory.set(target.value);
  }

  async pickWorkingDirectory(): Promise<void> {
    const selected = await this.recentDirsIpc.selectFolderAndTrack();
    if (!selected) return;
    this.workingDirectory.set(selected);
    await this.loadRecentDirectories();
  }

  async reload(): Promise<void> {
    const wd = this.workingDirectory();
    if (!wd) return;

    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await this.ipc.getApi()?.ecosystemList({ workingDirectory: wd });
      if (!response?.success) {
        this.error.set(response?.error?.message || 'Failed to load ecosystem');
        return;
      }
      this.ecosystem.set(response.data as unknown as EcosystemListResponse);

      // If selection exists, refresh the file content from latest file path.
      if (this.selectedKind() && this.selectedKey()) {
        this.refreshSelectionFilePath();
        if (this.selectedFilePath()) {
          await this.loadSelectedFile();
        }
      }
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async reloadInstructions(): Promise<void> {
    const wd = this.workingDirectory();
    if (!wd) return;

    this.instructionLoading.set(true);
    this.instructionError.set(null);
    try {
      const response = await this.instructionIpc.resolveInstructions(wd);
      if (!response.success || !response.data) {
        this.instructionError.set(response.error?.message || 'Failed to resolve instructions');
        return;
      }
      this.instructionResolution.set(response.data);
    } catch (error) {
      this.instructionError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.instructionLoading.set(false);
    }
  }

  private async setWatchDirectory(wd: string): Promise<void> {
    if (this.watchWorkingDirectory === wd) return;
    const prev = this.watchWorkingDirectory;
    this.watchWorkingDirectory = wd;
    try {
      if (prev) {
        await this.ipc.getApi()?.ecosystemWatchStop({ workingDirectory: prev });
      }
      await this.ipc.getApi()?.ecosystemWatchStart({ workingDirectory: wd });
    } catch {
      // ignore
    }
  }

  private refreshSelectionFilePath(): void {
    const kind = this.selectedKind();
    const key = this.selectedKey();
    if (!kind || !key) return;

    if (kind === 'command') {
      const cmd = this.commands().find((c) => c.name === key);
      this.selectedFilePath.set(cmd?.filePath || null);
      return;
    }
    if (kind === 'tool') {
      const t = this.tools().find((x) => x.id === key);
      this.selectedFilePath.set(t?.filePath || null);
      return;
    }
    if (kind === 'agent') {
      const a = this.agents().find((x) => x.profile.id === key);
      this.selectedFilePath.set(a?.source === 'file' ? a.filePath : null);
      return;
    }
    if (kind === 'plugin') {
      this.selectedFilePath.set(key);
    }
  }

  select(kind: EcosystemKind, key: string, filePath: string | null): void {
    this.selectedKind.set(kind);
    this.selectedKey.set(key);
    this.selectedFilePath.set(filePath);
    this.fileContent.set('');
    this.fileTruncated.set(false);
    if (filePath) void this.loadSelectedFile();
  }

  overrideFiles = computed(() => {
    const eco = this.ecosystem();
    const kind = this.selectedKind();
    const key = this.selectedKey();
    if (!eco || !kind || !key) return [];

    if (kind === 'command') {
      return (eco.commands.candidatesByName[key] || [])
        .map((c) => c.filePath)
        .filter(Boolean) as string[];
    }
    if (kind === 'tool') {
      return (eco.tools.candidatesById[key] || []).map((c) => c.filePath);
    }
    return this.selectedFilePath() ? [this.selectedFilePath()!] : [];
  });

  selectCandidateFile(filePath: string): void {
    this.selectedFilePath.set(filePath);
    void this.loadSelectedFile();
  }

  scanDirsForSelectedKind = computed(() => {
    const eco = this.ecosystem();
    const kind = this.selectedKind();
    if (!eco || !kind) return [];
    if (kind === 'command') return eco.commands.scanDirs;
    if (kind === 'agent') return eco.agents.scanDirs;
    if (kind === 'tool') return eco.tools.scanDirs;
    return eco.plugins.scanDirs;
  });

  async loadSelectedFile(): Promise<void> {
    const p = this.selectedFilePath();
    if (!p) return;
    try {
      const resp = await this.ipc.getApi()?.readTextFile(p);
      if (!resp?.success || !resp.data) {
        this.error.set(resp?.error?.message || 'Failed to read file');
        return;
      }
      const fileData = resp.data as FileReadTextResponse;
      this.fileContent.set(fileData.content || '');
      this.fileTruncated.set(Boolean(fileData.truncated));
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  onEdit(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.fileContent.set(target.value);
  }

  async saveFile(): Promise<void> {
    const p = this.selectedFilePath();
    if (!p) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const resp = await this.ipc.getApi()?.writeTextFile(
        { path: p, content: this.fileContent(), createDirs: false }
      );
      if (!resp?.success) {
        this.error.set(resp?.error?.message || 'Failed to write file');
        return;
      }
      await this.reload();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.saving.set(false);
    }
  }

  async generateInstructionDraft(): Promise<void> {
    const wd = this.workingDirectory();
    if (!wd) return;

    this.instructionLoading.set(true);
    this.instructionError.set(null);
    try {
      const response = await this.instructionIpc.createInstructionDraft(wd);
      if (!response.success || !response.data) {
        this.instructionError.set(response.error?.message || 'Failed to generate instruction draft');
        return;
      }
      this.instructionDraftPath.set(response.data.outputPath);
      this.instructionDraftContent.set(response.data.content);
      this.instructionResolution.set(response.data.resolution);
    } catch (error) {
      this.instructionError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.instructionLoading.set(false);
    }
  }

  onInstructionDraftEdit(event: Event): void {
    this.instructionDraftContent.set((event.target as HTMLTextAreaElement).value);
  }

  async saveInstructionDraft(): Promise<void> {
    const outputPath = this.instructionDraftPath();
    if (!outputPath) return;

    this.instructionSaving.set(true);
    this.instructionError.set(null);
    try {
      const response = await this.ipc.getApi()?.writeTextFile({
        path: outputPath,
        content: this.instructionDraftContent(),
        createDirs: true,
      });
      if (!response?.success) {
        this.instructionError.set(response?.error?.message || 'Failed to save instruction draft');
        return;
      }
      await this.reloadInstructions();
    } catch (error) {
      this.instructionError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.instructionSaving.set(false);
    }
  }

  async openPath(p: string): Promise<void> {
    await this.ipc.getApi()?.openPath(p);
  }

  async openContainingFolder(p: string): Promise<void> {
    const folder = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : p.includes('\\') ? p.slice(0, p.lastIndexOf('\\')) : p;
    await this.openPath(folder);
  }

  instructionSourceState(source: ResolvedInstructionSource): string {
    if (!source.loaded) return 'missing';
    return source.applied ? 'applied' : 'skipped';
  }

  private toNestedPath(name: string): string {
    return name.trim().replace(/:+/g, '/').replace(/^\/+|\/+$/g, '');
  }

  async createNew(kind: EcosystemKind): Promise<void> {
    const wd = this.workingDirectory();
    if (!wd) return;

    const input = prompt(`New ${kind} name (use ":" for nesting)`);
    const name = (input || '').trim();
    if (!name) return;

    const nested = this.toNestedPath(name);

    let filePath = '';
    let content = '';
    if (kind === 'command') {
      filePath = `${wd}/.orchestrator/commands/${nested}.md`;
      content = [
        '---',
        `name: ${name}`,
        'description: Custom command',
        '---',
        '',
        `# /${name}`,
        '',
        'Describe what this command should do.',
        '',
      ].join('\\n');
    } else if (kind === 'agent') {
      filePath = `${wd}/.orchestrator/agents/${nested}.md`;
      content = [
        '---',
        `name: ${name}`,
        'description: Custom agent',
        'mode: custom',
        'permissions:',
        '  read: allow',
        '  write: ask',
        '  bash: ask',
        '  web: allow',
        '  task: allow',
        '---',
        '',
        `# ${name}`,
        '',
        'System prompt for this agent goes here.',
        '',
      ].join('\\n');
    } else if (kind === 'tool') {
      filePath = `${wd}/.orchestrator/tools/${nested}.js`;
      content = [
        "const z = require('zod')",
        '',
        'module.exports = {',
        "  description: 'Custom tool',",
        '  args: {',
        '    // name: z.string(),',
        '  },',
        '  execute: async (args, ctx) => {',
        "    return { ok: true, args, workingDirectory: ctx.workingDirectory }",
        '  }',
        '}',
        '',
      ].join('\\n');
    } else if (kind === 'plugin') {
      filePath = `${wd}/.orchestrator/plugins/${nested}.js`;
      content = [
        'module.exports = {',
        "  'instance.created': async (payload) => {",
        '    // payload: instance data',
        '  },',
        "  'instance.output': async (payload) => {",
        '    // payload: { instanceId, message }',
        '  },',
        '}',
        '',
      ].join('\\n');
    }

    if (!filePath) return;

    const resp = await this.ipc.getApi()?.writeTextFile({
      path: filePath,
      content,
      createDirs: true,
    });
    if (!resp?.success) {
      this.error.set(resp?.error?.message || `Failed to create ${kind}`);
      return;
    }

    await this.reload();
  }
}
