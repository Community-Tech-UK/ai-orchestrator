# File Explorer Multi-Select Implementation Plan

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE.** Verified against the executing code: `selectedFiles` + Cmd/Shift click and range select in `file-explorer.component.ts`, multi-file drag (`application/x-file-paths`), `filePathsDropped` on the drop zone, `onFilePathsDropped()` in instance detail, dashboard wiring.


> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable multi-selecting files in the file explorer sidebar and dragging them all into the chat drop zone as a batch.

**Architecture:** Add selection state (Set<string>) and keyboard modifiers (Cmd+Click, Shift+Click, Cmd+A, Escape) to FileExplorerComponent. On drag, encode all selected paths as JSON in a new MIME type. DropZoneComponent reads the new type and emits a batch. InstanceDetailComponent handles the batch by fetching each file and adding to DraftService.

**Tech Stack:** Angular 21 signals, native DragEvent/DataTransfer API, existing DraftService

---

### Task 1: Add selection state and click handlers to FileExplorerComponent

**Files:**
- Modify: `src/renderer/app/features/file-explorer/file-explorer.component.ts`

**Step 1: Add selection signals**

Add these signals after the existing state signals (after line ~496):

```typescript
// Selection state
selectedFiles = signal<Set<string>>(new Set());
private lastClickedFile = signal<string | null>(null);
```

**Step 2: Add `is-selected` class binding to tree node template**

Replace the existing tree-node div (lines 87-114) — add `[class.is-selected]` binding:

```html
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
```

Note: `onNodeClick` now receives `$event` as second argument.

**Step 3: Add selected styles**

Add after the existing `.tree-node:active` style block:

```css
.tree-node.is-selected {
  background: rgba(var(--secondary-rgb), 0.2);
  color: var(--text-primary);
}

.tree-node.is-selected:hover {
  background: rgba(var(--secondary-rgb), 0.3);
}
```

**Step 4: Update `onNodeClick` to handle selection for files**

Replace the existing `onNodeClick` method. The new version handles file selection with Cmd/Shift modifiers while keeping directory expand/collapse:

```typescript
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
```

**Step 5: Add `rangeSelect` helper method**

Add after `onNodeClick`:

```typescript
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
```

**Step 6: Add Cmd+A and Escape keyboard handlers**

Add a new `@HostListener` for keyboard events on the component. Add to the class:

```typescript
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
```

**Step 7: Clear selection when tree changes (root change, refresh)**

In the existing `effect` in the constructor that watches `initialPath` (lines 469-484), add selection clearing when root changes. After `this.treeData.set(new Map())` on line 476, add:

```typescript
this.selectedFiles.set(new Set());
this.lastClickedFile.set(null);
```

Also in the `else` branch (line 482) after `this.treeData.set(new Map())`, add the same two lines.

**Step 8: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

**Step 9: Commit**

```bash
git add src/renderer/app/features/file-explorer/file-explorer.component.ts
git commit -m "feat: add multi-select state and click handlers to file explorer"
```

---

### Task 2: Update drag behavior for multi-file drags

**Files:**
- Modify: `src/renderer/app/features/file-explorer/file-explorer.component.ts`

**Step 1: Add new output for multi-file drags**

Add after the existing `fileDragged` output (line ~488):

```typescript
filesDragged = output<{ paths: string[]; names: string[] }>();
```

**Step 2: Replace `onDragStart` method**

Replace the existing `onDragStart` (lines 633-651) with multi-file-aware version:

```typescript
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
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/app/features/file-explorer/file-explorer.component.ts
git commit -m "feat: support multi-file drag with custom drag image and paths MIME type"
```

---

### Task 3: Update DropZoneComponent to handle multi-file paths

**Files:**
- Modify: `src/renderer/app/features/file-drop/drop-zone.component.ts`

**Step 1: Add new output**

Add after the existing `folderDropped` output (line ~113):

```typescript
filePathsDropped = output<string[]>();
```

**Step 2: Update `onDrop` to check for multi-file paths**

In the `onDrop` method, after the folder path check (line ~174), add the multi-file paths check BEFORE the single file path check:

Replace lines 176-180 (the single `application/x-file-path` block) with:

```typescript
// Check for multiple file paths from file explorer (multi-select drag)
const filePaths = event.dataTransfer?.getData('application/x-file-paths');
if (filePaths) {
  try {
    const paths: string[] = JSON.parse(filePaths);
    if (paths.length > 0) {
      this.filePathsDropped.emit(paths);
      return;
    }
  } catch {
    // Fall through to single file path
  }
}

// Check for single file path from file explorer
const filePath = event.dataTransfer?.getData('application/x-file-path');
if (filePath) {
  this.filePathDropped.emit(filePath);
}
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/app/features/file-drop/drop-zone.component.ts
git commit -m "feat: add filePathsDropped output for multi-file drops in drop zone"
```

---

### Task 4: Wire InstanceDetailComponent to handle multi-file drops

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts`

**Step 1: Add `filePathsDropped` binding to template**

In the `<app-drop-zone>` template (line ~54-59), add the new output binding:

```html
<app-drop-zone
  class="full-drop-zone"
  (filesDropped)="onFilesDropped($event)"
  (imagesPasted)="onImagesPasted($event)"
  (filePathDropped)="onFilePathDropped($event)"
  (filePathsDropped)="onFilePathsDropped($event)"
  (folderDropped)="onFolderDropped($event)"
>
```

**Step 2: Add `onFilePathsDropped` handler method**

Add after the existing `onFilePathDropped` method (after line ~593):

```typescript
async onFilePathsDropped(filePaths: string[]): Promise<void> {
  const inst = this.instance();
  if (!inst || !window.electronAPI) return;

  const files: File[] = [];
  for (const filePath of filePaths) {
    try {
      const stats = await window.electronAPI.getFileStats(filePath);
      if (!stats.success || !stats.data) continue;
      const data = stats.data as { isDirectory?: boolean };
      if (data.isDirectory) continue;

      const response = await fetch(`file://${filePath}`);
      const blob = await response.blob();
      const fileName = filePath.split('/').pop() || 'file';
      const file = new File([blob], fileName, {
        type: blob.type || 'application/octet-stream',
      });
      files.push(file);
    } catch (error) {
      console.warn('Failed to load file from path:', filePath, error);
    }
  }

  if (files.length > 0) {
    this.draftService.addPendingFiles(inst.id, files);
  }
}
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/app/features/instance-detail/instance-detail.component.ts
git commit -m "feat: handle multi-file path drops in instance detail"
```

---

### Task 5: Wire DashboardComponent template (optional cleanup)

**Files:**
- Modify: `src/renderer/app/features/dashboard/dashboard.component.html`
- Modify: `src/renderer/app/features/dashboard/dashboard.component.ts`

**Step 1: Add `filesDragged` binding to dashboard template**

In `dashboard.component.html`, update the file explorer element (lines 83-86):

```html
<app-file-explorer
  [initialPath]="selectedInstanceWorkingDir()"
  (fileDragged)="onFileDragged($event)"
  (filesDragged)="onFilesDragged($event)"
/>
```

**Step 2: Add handler in dashboard component**

In `dashboard.component.ts`, add after the existing `onFileDragged` method (line ~296):

```typescript
onFilesDragged(event: { paths: string[]; names: string[] }): void {
  // Multi-file drag from explorer - can be used for drag preview feedback
  console.log('Files dragged from explorer:', event.paths.length, 'files');
}
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/app/features/dashboard/dashboard.component.html src/renderer/app/features/dashboard/dashboard.component.ts
git commit -m "feat: wire multi-file drag output in dashboard"
```

---

### Task 6: Final verification

**Step 1: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 2: Run spec TypeScript check**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

**Step 3: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

**Step 4: Run tests**

Run: `npm run test`
Expected: PASS

**Step 5: Manual smoke test**

1. Start app: `npm start`
2. Open a folder in the file explorer
3. Click a file → it should highlight
4. Cmd+Click more files → they should add to selection
5. Shift+Click → range select should work
6. Cmd+A → all files selected
7. Escape → selection cleared
8. Drag a multi-selection into the chat → all files appear as pending attachments
9. Drag an unselected file → only that file attaches (selection resets)
10. Drag a folder → works as before (no selection involved)
