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
  untracked,
  OnDestroy
} from '@angular/core';
import { IpcFacadeService } from '../../core/services/ipc';
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import type { RecentDirectoriesOptions } from '../../../../shared/types/recent-directories.types';
import { InstructionInspectorComponent } from './instruction-inspector.component';
import { SettingsSectionTabsComponent } from './ui/settings-section-tabs.component';
import type { SettingsSectionTab } from './settings-navigation';
import { SaveStateBannerComponent, type SaveState } from './ui/save-state-banner.component';
import {
  mergeOutputStyleOptions,
  type BuiltInOutputStyleDto,
  type OutputStyleOption,
  type UserOutputStyleDto,
} from './output-style-options';

/** File-backed ecosystem resource kinds — each maps to a directory scan and an editable file. */
type EcosystemKind = 'command' | 'agent' | 'tool' | 'plugin';

/**
 * Every category the single-category resource editor can show, including the
 * non-file-backed output-style picker (activated, not edited as a file, here).
 */
type EcosystemCategory = EcosystemKind | 'output-style';

/** A category in the Ecosystem section switcher (see `ECOSYSTEM_CATEGORIES`). */
interface EcosystemCategoryDefinition {
  id: EcosystemCategory;
  label: string;
  /** Present only for categories that support creating a new resource. */
  createLabel?: string;
}

const ECOSYSTEM_CATEGORIES: EcosystemCategoryDefinition[] = [
  { id: 'command', label: 'Commands', createLabel: 'New command' },
  { id: 'agent', label: 'Agents', createLabel: 'New agent' },
  { id: 'tool', label: 'Tools', createLabel: 'New tool' },
  { id: 'plugin', label: 'Plugins', createLabel: 'New plugin' },
  { id: 'output-style', label: 'Output style' },
];

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
  outputStyles?: {
    styles: UserOutputStyleDto[];
    scanDirs: string[];
  };
  builtInOutputStyles?: BuiltInOutputStyleDto[];
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
  imports: [InstructionInspectorComponent, SettingsSectionTabsComponent, SaveStateBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ecosystem-settings-tab.component.html',
  styleUrl: './ecosystem-settings-tab.component.scss',
})
export class EcosystemSettingsTabComponent implements OnDestroy {
  private ipc = inject(IpcFacadeService);
  private recentDirsIpc = inject(RecentDirectoriesIpcService);
  private settingsStore = inject(SettingsStore);

  recentDirectories = signal<{ path: string }[]>([]);
  workingDirectory = signal<string>('');

  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);
  /** Error from the most recent save attempt — feeds the save-state banner. */
  saveError = signal<string | null>(null);

  ecosystem = signal<EcosystemListResponse | null>(null);

  /** Category currently shown by the single-category list/detail workspace. */
  activeCategory = signal<EcosystemCategory>('command');

  selectedKind = signal<EcosystemKind | null>(null);
  selectedKey = signal<string | null>(null);
  selectedFilePath = signal<string | null>(null);
  /** Selected output-style name — tracked separately since styles are activated, not file-edited. */
  selectedOutputStyleName = signal<string | null>(null);

  fileContent = signal('');
  /** Last content loaded from disk (or last successful save) — the unsaved-changes baseline. */
  originalFileContent = signal('');
  fileTruncated = signal(false);
  private unsubscribeChanged: (() => void) | null = null;
  private watchWorkingDirectory: string | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  commands = computed(() => this.ecosystem()?.commands.commands ?? []);
  agents = computed(() => this.ecosystem()?.agents.agents ?? []);
  tools = computed(() => this.ecosystem()?.tools.tools ?? []);
  plugins = computed(() => this.ecosystem()?.plugins.plugins ?? []);

  /** Built-in + user output styles, merged for the picker. */
  outputStyleOptions = computed(() =>
    mergeOutputStyleOptions(
      this.ecosystem()?.builtInOutputStyles,
      this.ecosystem()?.outputStyles?.styles,
    ),
  );
  /** The currently-active output style (global `outputStyle` setting). */
  activeOutputStyle = computed(() => this.settingsStore.settings().outputStyle || 'default');
  /** Directories scanned for user-authored output styles. */
  outputStyleScanDirs = computed(() => this.ecosystem()?.outputStyles?.scanDirs ?? []);
  /** The selected output style's full option data, for the detail pane. */
  selectedOutputStyleDetail = computed<OutputStyleOption | null>(() => {
    const name = this.selectedOutputStyleName();
    if (!name) return null;
    return this.outputStyleOptions().find((o) => o.name === name) ?? null;
  });

  /** True when the open file's content diverges from its last-loaded/saved baseline. */
  hasUnsavedChanges = computed(() => this.fileContent() !== this.originalFileContent());

  /** Section-switcher tabs, one per resource category, with live item counts. */
  categoryTabs = computed<SettingsSectionTab[]>(() =>
    ECOSYSTEM_CATEGORIES.map((def) => ({
      id: def.id,
      label: def.label,
      panelId: `ecosystem-list-panel-${def.id}`,
      badge: String(this.countForCategory(def.id)),
    })),
  );
  activeCategoryDefinition = computed(
    () => ECOSYSTEM_CATEGORIES.find((def) => def.id === this.activeCategory()) ?? ECOSYSTEM_CATEGORIES[0],
  );
  activeCategoryLabel = computed(() => this.activeCategoryDefinition().label);
  activeListPanelId = computed(() => `ecosystem-list-panel-${this.activeCategory()}`);

  /** Explicit Saved/Saving/Unsaved/Error state for the shared save-state banner. */
  saveState = computed<SaveState>(() => {
    if (this.saving()) return 'saving';
    if (this.saveError()) return 'error';
    if (this.hasUnsavedChanges()) return 'dirty';
    return 'saved';
  });

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
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
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

  /** Label used in discard-confirmation prompts for whatever is currently open. */
  private openResourceLabel(): string {
    const kind = this.selectedKind();
    const key = this.selectedKey();
    return kind && key ? `${kind} "${key}"` : 'this item';
  }

  /**
   * Gate a navigation action (switching item/category/working directory, or an
   * explicit or file-watcher-triggered reload) behind an explicit Discard/Cancel
   * decision whenever the open file has unsaved edits. Returns true once it is
   * safe to proceed; a `false` return means the caller must leave all state
   * (selection, category, working directory, and editor text) untouched.
   *
   * `reload()` calls this synchronously from the constructor's working-directory
   * `effect()`, so these signal reads run `untracked` — otherwise the effect
   * would pick up `hasUnsavedChanges`/`selectedKind`/`selectedKey` as extra
   * dependencies and re-fire (silently reloading the open file) on every edit.
   */
  private confirmDiscard(consequence: string): boolean {
    return untracked(() => {
      if (!this.hasUnsavedChanges()) return true;
      return confirm(`Discard unsaved changes to ${this.openResourceLabel()}? ${consequence}`);
    });
  }

  private clearSelection(): void {
    this.selectedKind.set(null);
    this.selectedKey.set(null);
    this.selectedFilePath.set(null);
    this.selectedOutputStyleName.set(null);
    this.fileContent.set('');
    this.originalFileContent.set('');
    this.fileTruncated.set(false);
    this.saveError.set(null);
  }

  /** Switch the visible resource category (bound to the shared section switcher). */
  selectCategory(categoryId: string): void {
    const category = categoryId as EcosystemCategory;
    if (category === this.activeCategory()) return;
    if (!this.confirmDiscard('Switching categories will discard them.')) return;
    this.activeCategory.set(category);
    this.clearSelection();
  }

  private countForCategory(id: EcosystemCategory): number {
    switch (id) {
      case 'command':
        return this.commands().length;
      case 'agent':
        return this.agents().length;
      case 'tool':
        return this.tools().length;
      case 'plugin':
        return this.plugins().length;
      case 'output-style':
        return this.outputStyleOptions().length;
    }
  }

  onSelectWorkingDirectory(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const next = target.value;
    if (next === this.workingDirectory()) return;
    if (!this.confirmDiscard('Changing the working directory will discard them.')) {
      // Snap the <select> back to the current value on the next render.
      target.value = this.workingDirectory();
      return;
    }
    this.clearSelection();
    this.workingDirectory.set(next);
  }

  async pickWorkingDirectory(): Promise<void> {
    if (!this.confirmDiscard('Changing the working directory will discard them.')) return;
    const selected = await this.recentDirsIpc.selectFolderAndTrack();
    if (!selected) return;
    this.clearSelection();
    this.workingDirectory.set(selected);
    await this.loadRecentDirectories();
  }

  async reload(): Promise<void> {
    const wd = this.workingDirectory();
    if (!wd) return;
    if (!this.confirmDiscard('Reloading will replace it with the file on disk.')) return;

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
    if (this.selectedKind() === kind && this.selectedKey() === key) return;
    if (!this.confirmDiscard('Selecting a different item will discard them.')) return;
    this.selectedKind.set(kind);
    this.selectedKey.set(key);
    this.selectedFilePath.set(filePath);
    this.selectedOutputStyleName.set(null);
    this.fileContent.set('');
    this.originalFileContent.set('');
    this.fileTruncated.set(false);
    this.saveError.set(null);
    if (filePath) void this.loadSelectedFile();
  }

  /**
   * Select an output style for the detail pane and make it the active one.
   * Persists the global `outputStyle` setting; the main process applies it to
   * the system prompt of new root sessions (built-ins append, user `.md`
   * styles may replace). Selecting and activating stay one step, matching the
   * picker's pre-existing click-to-activate behavior.
   */
  selectOutputStyle(name: string): void {
    if (!this.confirmDiscard('Selecting a different output style will discard them.')) return;
    this.selectedOutputStyleName.set(name);
    this.setOutputStyle(name);
  }

  /**
   * Make an output style the active one. Persists the global `outputStyle`
   * setting; the main process applies it to the system prompt of new root
   * sessions (built-ins append, user `.md` styles may replace).
   */
  setOutputStyle(name: string): void {
    void this.settingsStore.set('outputStyle', name);
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
    if (filePath === this.selectedFilePath()) return;
    if (!this.confirmDiscard('Selecting a different file will discard them.')) return;
    this.selectedFilePath.set(filePath);
    this.fileContent.set('');
    this.originalFileContent.set('');
    this.saveError.set(null);
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
      this.originalFileContent.set(fileData.content || '');
      this.fileTruncated.set(Boolean(fileData.truncated));
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  /** Reload the open file from disk, discarding in-memory edits (guarded). */
  async reloadSelectedFile(): Promise<void> {
    if (!this.confirmDiscard('Reloading the file will discard them.')) return;
    await this.loadSelectedFile();
  }

  onEdit(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.fileContent.set(target.value);
  }

  /** Revert in place to the last-loaded/saved content without navigating away. */
  discardEdits(): void {
    this.fileContent.set(this.originalFileContent());
    this.saveError.set(null);
  }

  async saveFile(): Promise<void> {
    const p = this.selectedFilePath();
    if (!p) return;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const resp = await this.ipc.getApi()?.writeTextFile(
        { path: p, content: this.fileContent(), createDirs: false }
      );
      if (!resp?.success) {
        this.saveError.set(resp?.error?.message || 'Failed to write file');
        return;
      }
      this.originalFileContent.set(this.fileContent());
      await this.reload();
    } catch (e) {
      this.saveError.set(e instanceof Error ? e.message : String(e));
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

  /** Create-new handler bound from the list-pane header for file-backed categories. */
  createNewForActiveCategory(): void {
    const category = this.activeCategory();
    if (category === 'output-style') return;
    void this.createNew(category);
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
