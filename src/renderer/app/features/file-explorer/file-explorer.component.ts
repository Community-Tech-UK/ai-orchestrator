/**
 * File Explorer Component - Collapsible sidebar for browsing files
 * Supports drag-and-drop files into chat
 */

import {
  Component,
  inject,
  signal,
  computed,
  output,
  input,
  effect,
  ChangeDetectionStrategy,
  HostListener,
} from '@angular/core';
import { ElectronIpcService, FileEntry } from '../../core/services/ipc';
import { ViewLayoutService } from '../../core/services/view-layout.service';

interface TreeNode extends FileEntry {
  children?: TreeNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
  depth: number;
}

@Component({
  selector: 'app-file-explorer',
  standalone: true,
  template: `
    <div class="file-explorer-wrapper" [class.collapsed]="isCollapsed()" [class.resizing]="isResizing()">
      <!-- Resize handle -->
      @if (!isCollapsed()) {
        <div
          class="resize-handle"
          (mousedown)="onResizeStart($event)"
          [class.dragging]="isResizing()"
        ></div>
      }

      <div class="file-explorer" [style.width.px]="isCollapsed() ? 36 : explorerWidth()">
        <!-- Header with toggle -->
        <div class="explorer-header" (click)="toggleCollapse()" (keydown.enter)="toggleCollapse()" (keydown.space)="toggleCollapse()" tabindex="0" role="button">
        <span class="collapse-icon">{{ isCollapsed() ? '📁' : '📂' }}</span>
        <span class="header-title" [class.hidden]="isCollapsed()">Files</span>
        @if (!isCollapsed()) {
          <span class="close-arrow" title="Close panel">›</span>
        }
      </div>

      @if (!isCollapsed()) {
        <!-- Root folder selector -->
        <div class="root-selector">
          <button class="select-root-btn" (click)="onSelectRoot()" title="Select folder">
            📁 {{ rootName() || 'Select folder...' }}
          </button>
          @if (rootPath()) {
            <button class="refresh-btn" (click)="refresh()" title="Refresh">↻</button>
          }
        </div>

        <!-- Options bar -->
        <div class="options-bar">
          <label class="option-checkbox">
            <input
              type="checkbox"
              [checked]="showHidden()"
              (change)="onToggleHidden()"
            />
            Show hidden
          </label>
        </div>

        <!-- File tree -->
        <div class="file-tree">
          @if (isLoading()) {
            <div class="loading">Loading...</div>
          } @else if (error()) {
            <div class="error">{{ error() }}</div>
          } @else if (!rootPath()) {
            <div class="empty-state">
              <p>No folder selected</p>
              <p class="hint">Click above to select a folder</p>
            </div>
          } @else {
            @for (node of flattenedTree(); track node.path) {
              <div
                class="tree-node"
                [class.is-directory]="node.isDirectory"
                [class.is-expanded]="node.isExpanded"
                [class.is-selected]="!node.isDirectory && selectedFiles().has(node.path)"
                [style.padding-left.px]="8 + node.depth * 16"
                draggable="true"
                (dragstart)="onDragStart($event, node)"
                (click)="onNodeClick(node, $event)"
                (keydown.enter)="onNodeClick(node, $event)"
                (keydown.space)="onNodeClick(node, $event)"
                tabindex="0"
                role="button"
              >
                @if (node.isDirectory) {
                  <span class="expand-icon">
                    @if (node.isLoading) {
                      <span class="loading-spinner-small"></span>
                    } @else {
                      {{ node.isExpanded ? '▼' : '▶' }}
                    }
                  </span>
                  <span class="node-icon">📁</span>
                } @else {
                  <span class="expand-icon"></span>
                  <span class="node-icon">{{ getFileIcon(node) }}</span>
                }
                <span class="node-name" [title]="node.path">{{ node.name }}</span>
              </div>
            } @empty {
              <div class="empty-state">
                <p>Folder is empty</p>
              </div>
            }
          }
        </div>
      }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      height: 100%;
    }

    /* Wrapper for resize handle + explorer */
    .file-explorer-wrapper {
      display: flex;
      height: 100%;
      position: relative;
    }

    .file-explorer-wrapper.collapsed {
      width: 36px;
    }

    .file-explorer-wrapper.resizing {
      user-select: none;
      cursor: col-resize;
    }

    /* Resize handle - Left edge */
    .resize-handle {
      width: 4px;
      height: 100%;
      background: transparent;
      cursor: col-resize;
      flex-shrink: 0;
      transition: background var(--transition-fast);
      z-index: 10;
    }

    .resize-handle:hover,
    .resize-handle.dragging {
      background: var(--secondary-color);
      box-shadow: 0 0 12px rgba(var(--secondary-rgb), 0.5);
    }

    /* File Explorer - Sidebar panel */
    .file-explorer {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-secondary);
      border-left: 1px solid var(--border-color);
      min-width: 36px;
      max-width: 500px;
      overflow: hidden;
      position: relative;
    }

    /* Explorer Header */
    .explorer-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 10px;
      border-bottom: 1px solid var(--border-color);
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
      background: var(--bg-tertiary);
      transition: background var(--transition-fast);
    }

    .explorer-header:hover {
      background: var(--bg-hover);
    }

    .collapse-icon {
      font-size: 14px;
      color: var(--text-muted);
      width: 16px;
      text-align: center;
      transition: color var(--transition-fast);
    }

    .explorer-header:hover .collapse-icon {
      color: var(--secondary-color);
    }

    .header-title {
      font-family: var(--font-display);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .header-title.hidden {
      display: none;
    }

    .close-arrow {
      margin-left: auto;
      font-size: 18px;
      color: var(--text-muted);
      transition: all var(--transition-fast);
    }

    .explorer-header:hover .close-arrow {
      color: var(--secondary-color);
      transform: translateX(2px);
    }

    /* Root Selector */
    .root-selector {
      display: flex;
      gap: 4px;
      padding: var(--spacing-sm);
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }

    .select-root-btn {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.02em;
      cursor: pointer;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: all var(--transition-fast);
    }

    .select-root-btn:hover {
      background: var(--bg-hover);
      border-color: var(--secondary-color);
      color: var(--text-primary);
    }

    .refresh-btn {
      padding: 8px 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      color: var(--text-muted);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .refresh-btn:hover {
      background: var(--bg-hover);
      color: var(--secondary-color);
      transform: rotate(180deg);
    }

    /* Options Bar */
    .options-bar {
      display: flex;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
      background: var(--bg-tertiary);
    }

    .option-checkbox {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.03em;
      color: var(--text-muted);
      cursor: pointer;
    }

    .option-checkbox input {
      cursor: pointer;
      accent-color: var(--secondary-color);
    }

    /* File Tree */
    .file-tree {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: var(--spacing-xs) 0;
      padding-right: 2px;
    }

    .file-tree::-webkit-scrollbar {
      width: 8px;
    }

    .file-tree::-webkit-scrollbar-track {
      background: var(--bg-tertiary);
      border-radius: 4px;
    }

    .file-tree::-webkit-scrollbar-thumb {
      background: var(--border-light);
      border-radius: 4px;
      border: 2px solid var(--bg-tertiary);
    }

    .file-tree::-webkit-scrollbar-thumb:hover {
      background: var(--text-muted);
    }

    /* Tree Node */
    .tree-node {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      cursor: pointer;
      user-select: none;
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.01em;
      color: var(--text-muted);
      border-radius: var(--radius-sm);
      margin: 1px 4px;
      transition: all var(--transition-fast);
    }

    .tree-node:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .tree-node.is-directory {
      color: var(--text-secondary);
      font-weight: 500;
    }

    .tree-node:active {
      background: rgba(var(--secondary-rgb), 0.15);
    }

    .tree-node.is-selected {
      background: rgba(var(--secondary-rgb), 0.2);
      color: var(--text-primary);
    }

    .tree-node.is-selected:hover {
      background: rgba(var(--secondary-rgb), 0.3);
    }

    .expand-icon {
      width: 12px;
      font-size: 8px;
      text-align: center;
      color: var(--text-muted);
      flex-shrink: 0;
      transition: transform var(--transition-fast);
    }

    .tree-node.is-expanded .expand-icon {
      color: var(--secondary-color);
    }

    .node-icon {
      font-size: 13px;
      flex-shrink: 0;
    }

    .node-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Loading State */
    .loading {
      padding: 20px;
      text-align: center;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.03em;
    }

    .loading-spinner-small {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 1.5px solid var(--border-subtle);
      border-top-color: var(--secondary-color);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }

    /* Error State */
    .error {
      padding: 20px;
      text-align: center;
      color: var(--error-color);
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.02em;
    }

    /* Empty State */
    .empty-state {
      padding: 32px 16px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
    }

    .empty-state p {
      margin: 0;
      font-family: var(--font-display);
    }

    .empty-state .hint {
      margin-top: 6px;
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.03em;
      opacity: 0.7;
    }

    /* Drag Styling */
    .tree-node[draggable="true"] {
      cursor: grab;
    }

    .tree-node[draggable="true"]:active {
      cursor: grabbing;
      background: rgba(var(--secondary-rgb), 0.2);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileExplorerComponent {
  private ipc = inject(ElectronIpcService);
  private viewLayoutService = inject(ViewLayoutService);

  // Inputs - path to auto-load when it changes (e.g., from selected instance)
  initialPath = input<string | null>(null);

  constructor() {
    // Watch for initialPath changes and sync with selected instance's working directory
    effect(() => {
      const path = this.initialPath();
      if (path) {
        // Always sync to the selected instance's working directory
        if (path !== this.rootPath()) {
          // Reset and load the new root directory
          this.treeData.set(new Map());
          this.expandedPaths.set(new Set());
          this.selectedFiles.set(new Set());
          this.lastClickedFile.set(null);
          this.loadDirectory(path, true);
        }
      } else {
        // Clear the file explorer when no path is provided
        this.rootPath.set(null);
        this.treeData.set(new Map());
        this.selectedFiles.set(new Set());
        this.lastClickedFile.set(null);
      }
    });
  }

  // Outputs - emit file paths when dragged
  fileDragged = output<{ path: string; name: string; isDirectory: boolean }>();
  filesDragged = output<{ paths: string[]; names: string[] }>();

  // State
  isCollapsed = signal(true);  // Start collapsed by default
  rootPath = signal<string | null>(null);
  showHidden = signal(false);
  isLoading = signal(false);
  error = signal<string | null>(null);

  // Selection state
  selectedFiles = signal<Set<string>>(new Set());
  private lastClickedFile = signal<string | null>(null);

  // Resize state - using ViewLayoutService for persistence
  explorerWidth = signal(this.viewLayoutService.fileExplorerWidth);
  isResizing = signal(false);
  private resizeStartX = 0;
  private resizeStartWidth = 0;

  // Tree data: Map of path -> TreeNode
  private treeData = signal<Map<string, TreeNode>>(new Map());
  private expandedPaths = signal<Set<string>>(new Set());

  // Computed: root folder name
  rootName = computed(() => {
    const path = this.rootPath();
    if (!path) return null;
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
  });

  // Computed: flattened tree for rendering
  flattenedTree = computed(() => {
    const root = this.rootPath();
    if (!root) return [];

    const tree = this.treeData();
    const expanded = this.expandedPaths();
    const result: TreeNode[] = [];

    const rootNode = tree.get(root);
    if (!rootNode?.children) return [];

    const addNodes = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        // Check if this node's children are loaded in the tree map
        const loadedNode = tree.get(node.path);
        const children = loadedNode?.children || node.children;
        const isExpanded = expanded.has(node.path);

        result.push({ ...node, depth, isExpanded, children });

        if (node.isDirectory && isExpanded && children) {
          addNodes(children, depth + 1);
        }
      }
    };

    addNodes(rootNode.children, 0);
    return result;
  });

  toggleCollapse(): void {
    this.isCollapsed.update(v => !v);
  }

  // Resize methods
  onResizeStart(event: MouseEvent): void {
    event.preventDefault();
    this.isResizing.set(true);
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.explorerWidth();
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (!this.isResizing()) return;

    // Dragging left = increasing width (since resize handle is on the left)
    const delta = this.resizeStartX - event.clientX;
    const newWidth = Math.max(180, Math.min(500, this.resizeStartWidth + delta));
    this.explorerWidth.set(newWidth);
    // Update service (debounced save)
    this.viewLayoutService.setFileExplorerWidth(newWidth);
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    if (this.isResizing()) {
      this.isResizing.set(false);
    }
  }

  @HostListener('keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    // Cmd/Ctrl+A: select all visible files
    if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
      event.preventDefault();
      event.stopPropagation();
      const allFilePaths = this.flattenedTree()
        .filter(n => !n.isDirectory)
        .map(n => n.path);
      this.selectedFiles.set(new Set(allFilePaths));
    }

    // Escape: clear selection
    if (event.key === 'Escape') {
      if (this.selectedFiles().size > 0) {
        event.stopPropagation();
        this.selectedFiles.set(new Set());
        this.lastClickedFile.set(null);
      }
    }
  }

  async onSelectRoot(): Promise<void> {
    const folder = await this.ipc.selectFolder();
    if (folder) {
      this.loadDirectory(folder);
    }
  }

  async refresh(): Promise<void> {
    const root = this.rootPath();
    if (root) {
      // Clear tree and reload
      this.treeData.set(new Map());
      await this.loadDirectory(root);

      // Reload expanded directories
      const expanded = this.expandedPaths();
      for (const path of expanded) {
        await this.loadDirectory(path);
      }
    }
  }

  onToggleHidden(): void {
    this.showHidden.update(v => !v);
    this.refresh();
  }

  async onNodeClick(node: TreeNode, event?: MouseEvent | KeyboardEvent): Promise<void> {
    if (node.isDirectory) {
      // Directories: expand/collapse only (no selection)
      const expanded = this.expandedPaths();
      if (expanded.has(node.path)) {
        this.expandedPaths.update(set => {
          const newSet = new Set(set);
          newSet.delete(node.path);
          return newSet;
        });
      } else {
        this.expandedPaths.update(set => {
          const newSet = new Set(set);
          newSet.add(node.path);
          return newSet;
        });

        const tree = this.treeData();
        const loadedNode = tree.get(node.path);
        if (!loadedNode?.children) {
          await this.loadDirectory(node.path);
        }
      }
      return;
    }

    // Files: handle selection
    const isMetaKey = event instanceof MouseEvent && (event.metaKey || event.ctrlKey);
    const isShiftKey = event instanceof MouseEvent && event.shiftKey;

    if (isShiftKey && this.lastClickedFile()) {
      // Shift+Click: range select
      this.rangeSelect(node.path);
    } else if (isMetaKey) {
      // Cmd/Ctrl+Click: toggle single file
      this.selectedFiles.update(set => {
        const newSet = new Set(set);
        if (newSet.has(node.path)) {
          newSet.delete(node.path);
        } else {
          newSet.add(node.path);
        }
        return newSet;
      });
      this.lastClickedFile.set(node.path);
    } else {
      // Plain click: select only this file
      this.selectedFiles.set(new Set([node.path]));
      this.lastClickedFile.set(node.path);
    }
  }

  private rangeSelect(toPath: string): void {
    const fromPath = this.lastClickedFile();
    if (!fromPath) {
      this.selectedFiles.set(new Set([toPath]));
      this.lastClickedFile.set(toPath);
      return;
    }

    const visibleFiles = this.flattenedTree().filter(n => !n.isDirectory);
    const fromIndex = visibleFiles.findIndex(n => n.path === fromPath);
    const toIndex = visibleFiles.findIndex(n => n.path === toPath);

    if (fromIndex === -1 || toIndex === -1) {
      this.selectedFiles.set(new Set([toPath]));
      this.lastClickedFile.set(toPath);
      return;
    }

    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    const rangePaths = visibleFiles.slice(start, end + 1).map(n => n.path);

    this.selectedFiles.set(new Set(rangePaths));
    // Keep lastClickedFile as the anchor (don't update it)
  }

  onDragStart(event: DragEvent, node: TreeNode): void {
    if (!event.dataTransfer) return;

    // If dragging a directory, use existing single-drag behavior
    if (node.isDirectory) {
      event.dataTransfer.setData('text/plain', node.path);
      event.dataTransfer.setData('application/x-folder-path', node.path);
      event.dataTransfer.effectAllowed = 'copy';
      this.fileDragged.emit({
        path: node.path,
        name: node.name,
        isDirectory: true,
      });
      return;
    }

    // If dragging an unselected file, clear selection and drag just that file
    const selected = this.selectedFiles();
    if (!selected.has(node.path)) {
      this.selectedFiles.set(new Set([node.path]));
      this.lastClickedFile.set(node.path);
    }

    // Gather all selected file paths
    const currentSelected = this.selectedFiles();
    const selectedNodes = this.flattenedTree().filter(
      n => !n.isDirectory && currentSelected.has(n.path)
    );
    const paths = selectedNodes.map(n => n.path);
    const names = selectedNodes.map(n => n.name);

    // Set drag data
    event.dataTransfer.setData('text/plain', paths.join('\n'));
    event.dataTransfer.setData('application/x-file-path', paths[0]);
    event.dataTransfer.setData('application/x-file-paths', JSON.stringify(paths));
    event.dataTransfer.effectAllowed = 'copy';

    // Custom drag image with count badge for multi-file
    if (paths.length > 1) {
      const dragEl = document.createElement('div');
      dragEl.style.cssText = 'position:absolute;top:-1000px;left:-1000px;padding:6px 12px;background:#1a1a2e;color:#e0e0e0;border:1px solid rgba(100,100,255,0.3);border-radius:6px;font-family:monospace;font-size:12px;white-space:nowrap;';
      dragEl.textContent = `${paths.length} files`;
      document.body.appendChild(dragEl);
      event.dataTransfer.setDragImage(dragEl, 0, 0);
      // Clean up after drag starts
      requestAnimationFrame(() => document.body.removeChild(dragEl));
    }

    // Emit outputs for parent components
    this.fileDragged.emit({
      path: paths[0],
      name: names[0],
      isDirectory: false,
    });
    if (paths.length > 0) {
      this.filesDragged.emit({ paths, names });
    }
  }

  getFileIcon(node: TreeNode): string {
    if (node.isDirectory) return '📁';

    const ext = node.extension?.toLowerCase();
    switch (ext) {
      // Code files
      case 'ts':
      case 'tsx':
        return '🔷';
      case 'js':
      case 'jsx':
        return '🟨';
      case 'py':
        return '🐍';
      case 'rs':
        return '🦀';
      case 'go':
        return '🔵';
      case 'java':
        return '☕';
      case 'rb':
        return '💎';
      case 'php':
        return '🐘';
      case 'swift':
        return '🧡';
      case 'kt':
        return '🟣';
      case 'c':
      case 'cpp':
      case 'h':
      case 'hpp':
        return '⚙️';

      // Web files
      case 'html':
      case 'htm':
        return '🌐';
      case 'css':
      case 'scss':
      case 'sass':
      case 'less':
        return '🎨';

      // Config files
      case 'json':
        return '📋';
      case 'yaml':
      case 'yml':
        return '📝';
      case 'toml':
        return '⚙️';
      case 'xml':
        return '📄';

      // Documents
      case 'md':
      case 'mdx':
        return '📝';
      case 'txt':
        return '📄';
      case 'pdf':
        return '📕';
      case 'doc':
      case 'docx':
        return '📘';

      // Images
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
      case 'webp':
        return '🖼️';

      // Data
      case 'csv':
        return '📊';
      case 'sql':
        return '🗃️';

      // Shell
      case 'sh':
      case 'bash':
      case 'zsh':
        return '💻';

      // Archives
      case 'zip':
      case 'tar':
      case 'gz':
      case '7z':
        return '📦';

      default:
        return '📄';
    }
  }

  private async loadDirectory(path: string, forceAsRoot = false): Promise<void> {
    const isRoot = forceAsRoot || !this.rootPath();

    if (isRoot) {
      this.isLoading.set(true);
      this.error.set(null);
      this.rootPath.set(path);
    }

    // Mark node as loading in tree
    this.updateNodeLoading(path, true);

    try {
      const entries = await this.ipc.readDir(path, this.showHidden());

      if (!entries) {
        throw new Error('Failed to read directory');
      }

      // Convert to tree nodes
      const children: TreeNode[] = entries.map(entry => ({
        ...entry,
        depth: 0,
        isExpanded: false,
        children: entry.isDirectory ? undefined : undefined,
      }));

      // Update tree data
      this.treeData.update(tree => {
        const newTree = new Map(tree);
        const node: TreeNode = newTree.get(path) || {
          name: path.split('/').pop() || path,
          path,
          isDirectory: true,
          isSymlink: false,
          size: 0,
          modifiedAt: Date.now(),
          depth: 0,
        };

        newTree.set(path, {
          ...node,
          children,
          isLoading: false,
        });

        return newTree;
      });

    } catch (err) {
      if (isRoot) {
        this.error.set((err as Error).message);
        this.rootPath.set(null);
      }
      console.error('Failed to load directory:', err);
    } finally {
      if (isRoot) {
        this.isLoading.set(false);
      }
      this.updateNodeLoading(path, false);
    }
  }

  private updateNodeLoading(path: string, isLoading: boolean): void {
    this.treeData.update(tree => {
      const newTree = new Map(tree);
      const node = newTree.get(path);
      if (node) {
        newTree.set(path, { ...node, isLoading });
      }
      return newTree;
    });
  }

  private findNode(tree: Map<string, TreeNode>, path: string): TreeNode | undefined {
    // Check direct match first
    if (tree.has(path)) {
      return tree.get(path);
    }

    // Recursively search in children
    const searchChildren = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const node of nodes) {
        if (node.path === path) {
          return node;
        }
        if (node.children) {
          const found = searchChildren(node.children);
          if (found) return found;
        }
      }
      return undefined;
    };

    for (const node of tree.values()) {
      if (node.children) {
        const found = searchChildren(node.children);
        if (found) return found;
      }
    }

    return undefined;
  }
}
