/**
 * Files page — two-pane file movement between this Mac (coordinator) and a
 * connected worker node.
 *
 * Left pane browses the local filesystem, right pane browses the selected
 * worker's approved folders (transfer roots + working directories). Dragging
 * files from one pane and dropping them on the other copies them over the
 * existing checksummed transfer channel. Folders are not draggable transfers —
 * agents use sync_to_node / sync_from_node for those.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FileExplorerComponent } from '../file-explorer/file-explorer.component';
import { RemoteNodesStore } from '../remote-nodes/remote-nodes.store';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';
import { isRemoteNodeOnline } from '../../core/state/remote-node-connectivity';

interface TransferRootOption {
  label: string;
  path: string;
  write: boolean;
}

interface TransferStatus {
  name: string;
  direction: 'send' | 'fetch';
  status: 'copying' | 'done' | 'failed';
  error?: string;
}

type DragSource = 'local' | 'remote' | null;

@Component({
  selector: 'app-files-page',
  standalone: true,
  imports: [FileExplorerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="files-page">
      <header class="files-header">
        <h1>Files</h1>
        <p class="subtitle">Drag files between this Mac and a worker to copy them.</p>
      </header>

      <div class="files-panes">
        <section
          class="pane"
          [class.drop-target]="dragSource() === 'remote'"
          (dragover)="onDragOver($event, 'remote')"
          (drop)="onDropToLocal($event)"
        >
          <div class="pane-title">This Mac</div>
          <app-file-explorer
            #localPane
            (filesDragged)="onPaneDragStart('local', $event.paths)"
            (fileDragged)="onPaneSingleDragStart('local', $event)"
          />
        </section>

        <section
          class="pane"
          [class.drop-target]="dragSource() === 'local'"
          (dragover)="onDragOver($event, 'local')"
          (drop)="onDropToRemote($event)"
        >
          <div class="pane-title">
            <select
              class="pane-select"
              aria-label="Worker node"
              (change)="onNodeChange($event)"
            >
              @if (!selectedNodeId()) {
                <option value="" selected>Select worker…</option>
              }
              @for (node of connectedNodes(); track node.id) {
                <option [value]="node.id" [selected]="node.id === selectedNodeId()">
                  {{ node.name }}
                </option>
              }
            </select>
            @if (remoteRoots().length > 0) {
              <select
                class="pane-select"
                aria-label="Worker folder"
                (change)="onRootChange($event)"
              >
                @for (root of remoteRoots(); track root.path) {
                  <option [value]="root.path" [selected]="root.path === selectedRootPath()">
                    {{ root.label }}{{ root.write ? '' : ' (read-only)' }}
                  </option>
                }
              </select>
            }
          </div>
          @if (selectedNodeId()) {
            <app-file-explorer
              #remotePane
              [initialPath]="selectedRootPath()"
              [executionNodeId]="selectedNodeId()"
              (filesDragged)="onPaneDragStart('remote', $event.paths)"
              (fileDragged)="onPaneSingleDragStart('remote', $event)"
            />
          } @else {
            <div class="pane-empty">
              @if (connectedNodes().length === 0) {
                <p>No workers connected.</p>
              } @else {
                <p>Select a worker to browse its approved folders.</p>
              }
            </div>
          }
        </section>
      </div>

      @if (transfers().length > 0) {
        <section class="transfer-log" aria-live="polite">
          @for (transfer of transfers(); track $index) {
            <div class="transfer-row" [class.failed]="transfer.status === 'failed'">
              <span class="transfer-name">{{ transfer.name }}</span>
              <span class="transfer-direction">{{ transfer.direction === 'send' ? '→ worker' : '→ Mac' }}</span>
              <span class="transfer-status">
                {{ transfer.status === 'copying' ? 'Copying…' : transfer.status === 'done' ? 'Done' : transfer.error }}
              </span>
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .files-page {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 16px;
      gap: 12px;
    }

    .files-header h1 {
      margin: 0;
      font-size: 20px;
    }

    .files-header .subtitle {
      margin: 4px 0 0;
      color: var(--text-muted);
      font-size: 12px;
    }

    .files-panes {
      display: flex;
      flex: 1;
      min-height: 0;
      gap: 12px;
    }

    .pane {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md, 8px);
      background: var(--bg-secondary);
      overflow: hidden;
    }

    .pane.drop-target {
      border-color: var(--secondary-color, #5b8cff);
      box-shadow: 0 0 0 2px rgba(91, 140, 255, 0.25) inset;
    }

    .pane-title {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .pane-select {
      background: var(--bg-secondary);
      color: var(--text-primary);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      font-size: 12px;
      padding: 4px 6px;
      max-width: 220px;
    }

    .pane app-file-explorer {
      flex: 1;
      min-height: 0;
    }

    .pane-empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 13px;
    }

    .transfer-log {
      max-height: 140px;
      overflow-y: auto;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md, 8px);
      padding: 6px 10px;
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .transfer-row {
      display: flex;
      gap: 10px;
      padding: 2px 0;
      color: var(--text-secondary);
    }

    .transfer-row.failed {
      color: var(--error-color, #f08585);
    }

    .transfer-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `],
})
export class FilesPageComponent implements OnInit {
  private readonly nodesStore = inject(RemoteNodesStore);
  private readonly remoteNodeIpc = inject(RemoteNodeIpcService);

  private readonly localPane = viewChild<FileExplorerComponent>('localPane');
  private readonly remotePane = viewChild<FileExplorerComponent>('remotePane');

  readonly connectedNodes = computed(() => this.nodesStore.nodes().filter(isRemoteNodeOnline));
  readonly selectedNodeId = signal<string | null>(null);
  readonly selectedRootPath = signal<string | null>(null);
  readonly transfers = signal<TransferStatus[]>([]);

  /** Which pane the in-flight drag started from; drives the drop highlight. */
  readonly dragSource = signal<DragSource>(null);
  private dragPaths: string[] = [];

  readonly remoteRoots = computed<TransferRootOption[]>(() => {
    const node = this.connectedNodes().find((entry) => entry.id === this.selectedNodeId());
    if (!node) {
      return [];
    }
    const transferRoots = (node.fileTransfer?.roots ?? []).map((root) => ({
      label: root.label,
      path: root.path,
      write: root.write,
    }));
    const workingDirs = (node.workingDirectories ?? []).map((path) => ({
      label: `Working: ${path}`,
      path,
      write: true,
    }));
    return [...transferRoots, ...workingDirs];
  });

  ngOnInit(): void {
    void this.nodesStore.refresh();
  }

  onNodeChange(event: Event): void {
    const nodeId = (event.target as HTMLSelectElement).value || null;
    this.selectedNodeId.set(nodeId);
    this.selectedRootPath.set(this.remoteRoots()[0]?.path ?? null);
  }

  onRootChange(event: Event): void {
    this.selectedRootPath.set((event.target as HTMLSelectElement).value || null);
  }

  onPaneDragStart(source: Exclude<DragSource, null>, paths: string[]): void {
    this.dragSource.set(source);
    this.dragPaths = paths;
  }

  onPaneSingleDragStart(
    source: Exclude<DragSource, null>,
    dragged: { path: string; name: string; isDirectory: boolean },
  ): void {
    if (dragged.isDirectory) {
      // Folder copies are a sync job, not a file transfer.
      this.dragSource.set(source);
      this.dragPaths = [];
      return;
    }
    if (this.dragSource() !== source || this.dragPaths.length === 0) {
      this.dragSource.set(source);
      this.dragPaths = [dragged.path];
    }
  }

  onDragOver(event: DragEvent, acceptedSource: Exclude<DragSource, null>): void {
    if (this.dragSource() === acceptedSource) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    }
  }

  async onDropToRemote(event: DragEvent): Promise<void> {
    event.preventDefault();
    if (this.dragSource() !== 'local') {
      return;
    }
    const paths = this.takeDragPaths();
    const nodeId = this.selectedNodeId();
    const destinationDir = this.remotePane()?.rootPath() ?? this.selectedRootPath();
    if (!nodeId || !destinationDir) {
      return;
    }
    for (const localPath of paths) {
      const name = basename(localPath);
      await this.runTransfer({ name, direction: 'send' }, () =>
        this.remoteNodeIpc.copyToRemote({
          nodeId,
          localPath,
          remotePath: joinLike(destinationDir, name),
        }));
    }
    await this.remotePane()?.refresh();
  }

  async onDropToLocal(event: DragEvent): Promise<void> {
    event.preventDefault();
    if (this.dragSource() !== 'remote') {
      return;
    }
    const paths = this.takeDragPaths();
    const nodeId = this.selectedNodeId();
    const destinationDir = this.localPane()?.rootPath();
    if (!nodeId || !destinationDir) {
      this.transfers.update((log) => [
        { name: 'Select a local folder first', direction: 'fetch', status: 'failed', error: 'No destination folder' },
        ...log,
      ]);
      return;
    }
    for (const remotePath of paths) {
      const name = basename(remotePath);
      await this.runTransfer({ name, direction: 'fetch' }, () =>
        this.remoteNodeIpc.copyFromRemote({
          nodeId,
          remotePath,
          localPath: joinLike(destinationDir, name),
        }));
    }
    await this.localPane()?.refresh();
  }

  private takeDragPaths(): string[] {
    const paths = this.dragPaths;
    this.dragPaths = [];
    this.dragSource.set(null);
    return paths;
  }

  private async runTransfer(
    entry: { name: string; direction: 'send' | 'fetch' },
    transfer: () => Promise<{ success: boolean; error?: string }>,
  ): Promise<void> {
    const row: TransferStatus = { ...entry, status: 'copying' };
    this.transfers.update((log) => [row, ...log].slice(0, 50));
    const result = await transfer();
    this.transfers.update((log) =>
      log.map((candidate) =>
        candidate === row
          ? {
              ...candidate,
              status: result.success ? 'done' as const : 'failed' as const,
              error: result.error,
            }
          : candidate,
      ));
  }
}

function basename(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

/** Join with the separator style of the destination directory (worker may be Windows). */
function joinLike(directory: string, name: string): string {
  const separator = directory.includes('\\') || /^[A-Za-z]:/.test(directory) ? '\\' : '/';
  const trimmed = directory.replace(/[\\/]+$/, '');
  return `${trimmed}${separator}${name}`;
}
