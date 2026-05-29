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
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import type { RecentDirectoriesOptions } from '../../../../shared/types/recent-directories.types';
import { InstructionInspectorComponent } from './instruction-inspector.component';

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
  imports: [InstructionInspectorComponent],
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

      <app-instruction-inspector [workingDirectory]="workingDirectory()" />

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
                <div class="empty">No commands yet — click New to create one</div>
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
                  title="{{ a.source === 'file' ? a.filePath : 'Built in to the app' }}"
                >
                  <div class="item-title">
                    {{ a.profile.name }}
                    <span class="pill" [class.builtin]="a.source === 'built-in'">{{
                      a.source === 'built-in' ? 'built-in' : 'custom'
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
                <div class="empty">No tools yet — click New to create one</div>
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
                    {{ p.hookKeys.length }} event {{ p.hookKeys.length === 1 ? 'handler' : 'handlers' }}
                  </div>
                </button>
              }
              @if (plugins().length === 0) {
                <div class="empty">No plugins yet — click New to create one</div>
              }
            </div>
          </div>
        </div>

        <div class="right">
          @if (!selectedKind()) {
            <div class="placeholder">
              Select an item on the left to view or edit it.
            </div>
          } @else {
            <div class="detail">
              <div class="detail-header">
                <div class="detail-title">
                  {{ selectedKind() }}: {{ selectedKey() }}
                </div>
                <div class="detail-actions">
                  @if (selectedFilePath()) {
                    <button class="btn" (click)="openPath(selectedFilePath()!)">Open file</button>
                    <button class="btn" (click)="openContainingFolder(selectedFilePath()!)">Show in folder</button>
                    <button class="btn" (click)="loadSelectedFile()">Reload file</button>
                  }
                </div>
              </div>

              <div class="meta">
                <div class="row">
                  <span class="k">File</span>
                  <span class="v">{{ selectedFilePath() || 'No file (built-in)' }}</span>
                </div>

                @if (overrideFiles().length > 1) {
                  <div class="row">
                    <span class="k">Other versions</span>
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
                  This item is built into the app and cannot be edited here.
                </div>
              } @else {
                @if (fileTruncated()) {
                  <div class="warn">This file is large — only the first portion is shown below.</div>
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
                    Refresh list
                  </button>
                </div>
              }

              <div class="scan">
                <div class="scan-title">Where the app looks for {{ selectedKind() === 'command' ? 'commands' : selectedKind() === 'agent' ? 'agents' : selectedKind() === 'tool' ? 'tools' : 'plugins' }}</div>
                <div class="scan-list">
                  @for (d of scanDirsForSelectedKind(); track d) {
                    <div class="scan-item">{{ d }}</div>
                  }
                </div>
              </div>

              @if ((ecosystem()?.tools?.errors?.length || 0) > 0 || (ecosystem()?.plugins?.errors?.length || 0) > 0) {
                <div class="scan">
                  <div class="scan-title">Files that failed to load</div>
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
  styleUrl: './ecosystem-settings-tab.component.scss'
})
export class EcosystemSettingsTabComponent implements OnDestroy {
  private ipc = inject(ElectronIpcService);
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
  private unsubscribeChanged: (() => void) | null = null;
  private watchWorkingDirectory: string | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  commands = computed(() => this.ecosystem()?.commands.commands ?? []);
  agents = computed(() => this.ecosystem()?.agents.agents ?? []);
  tools = computed(() => this.ecosystem()?.tools.tools ?? []);
  plugins = computed(() => this.ecosystem()?.plugins.plugins ?? []);

  constructor() {
    void this.loadRecentDirectories();

    effect(() => {
      const wd = this.workingDirectory();
      if (!wd) return;
      void this.setWatchDirectory(wd);
      void this.reload();
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
        this.error.set(response?.error?.message || 'Failed to load the ecosystem catalog');
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

  async openPath(p: string): Promise<void> {
    await this.ipc.getApi()?.openPath(p);
  }

  async openContainingFolder(p: string): Promise<void> {
    const folder = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : p.includes('\\') ? p.slice(0, p.lastIndexOf('\\')) : p;
    await this.openPath(folder);
  }

  private toNestedPath(name: string): string {
    return name.trim().replace(/:+/g, '/').replace(/^\/+|\/+$/g, '');
  }

  async createNew(kind: EcosystemKind): Promise<void> {
    const wd = this.workingDirectory();
    if (!wd) return;

    const input = prompt(`Name for new ${kind} (use ":" to create sub-folders, e.g. "utils:helper")`);
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
