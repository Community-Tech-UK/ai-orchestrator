import { Injectable, inject, signal, computed } from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { RecentDirectoriesIpcService, VcsIpcService } from '../../core/services/ipc';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { FileAttachmentService } from './file-attachment.service';
import type { RecentDirectoryEntry } from '../../../../shared/types/recent-directories.types';

export interface WelcomeProjectContext {
  branch: string | null;
  hasChanges: boolean;
  isRepo: boolean;
  lastAccessed: number | null;
  draftUpdatedAt: number | null;
  hasDraft: boolean;
}

@Injectable({ providedIn: 'root' })
export class WelcomeCoordinatorService {
  private store = inject(InstanceStore);
  private remoteNodeStore = inject(RemoteNodeStore);
  private recentDirsService = inject(RecentDirectoriesIpcService);
  private vcsIpc = inject(VcsIpcService);
  private providerState = inject(ProviderStateService);
  private newSessionDraft = inject(NewSessionDraftService);
  private fileAttachment = inject(FileAttachmentService);

  // ---------------------------------------------------------------------------
  // Public signals — bound in the component template
  // ---------------------------------------------------------------------------

  /** The node ID currently selected in the welcome node picker. */
  welcomeSelectedNodeId = signal<string | null>(null);

  /** Controls visibility of the remote-browse modal. */
  remoteBrowseOpen = signal(false);

  /** Node ID passed to the remote-browse modal. */
  remoteBrowseNodeId = signal<string | null>(null);

  /** True while the async project-context load is in flight. */
  isWelcomeProjectContextLoading = signal(false);

  // ---------------------------------------------------------------------------
  // Private state
  // ---------------------------------------------------------------------------

  private welcomeProjectSnapshot = signal<{
    branch: string | null;
    hasChanges: boolean;
    isRepo: boolean;
    lastAccessed: number | null;
  } | null>(null);

  private welcomeContextRequestId = 0;

  // ---------------------------------------------------------------------------
  // Delegated signals from NewSessionDraftService (convenience re-exports)
  // ---------------------------------------------------------------------------

  readonly pendingFiles = this.newSessionDraft.pendingFiles;
  readonly pendingFolders = this.newSessionDraft.pendingFolders;
  readonly workingDirectory = this.newSessionDraft.workingDirectory;

  // ---------------------------------------------------------------------------
  // Computed values
  // ---------------------------------------------------------------------------

  readonly selectedCli = computed(
    () =>
      this.newSessionDraft.provider() ??
      this.providerState.getProviderForCreation() ??
      'auto',
  );

  readonly projectContext = computed<WelcomeProjectContext | null>(() => {
    const workingDirectory = this.workingDirectory();
    if (!workingDirectory) {
      return null;
    }

    const snapshot = this.welcomeProjectSnapshot();
    return {
      branch: snapshot?.branch ?? null,
      hasChanges: snapshot?.hasChanges ?? false,
      isRepo: snapshot?.isRepo ?? false,
      lastAccessed: snapshot?.lastAccessed ?? null,
      draftUpdatedAt: this.newSessionDraft.updatedAt(),
      hasDraft:
        this.newSessionDraft.hasActiveContent() ||
        this.pendingFiles().length > 0,
    };
  });

  // ---------------------------------------------------------------------------
  // Lifecycle helpers (called by the component on instance change)
  // ---------------------------------------------------------------------------

  /**
   * Resets all welcome-screen transient state.
   * Call this whenever the selected instance changes so state doesn't bleed
   * across sessions.
   */
  resetState(): void {
    this.welcomeSelectedNodeId.set(this.newSessionDraft.nodeId());
    this.remoteBrowseOpen.set(false);
    this.remoteBrowseNodeId.set(null);
    this.welcomeProjectSnapshot.set(null);
    this.isWelcomeProjectContextLoading.set(false);
  }

  // ---------------------------------------------------------------------------
  // Node selection
  // ---------------------------------------------------------------------------

  onWelcomeNodeChange(nodeId: string | null): void {
    this.welcomeSelectedNodeId.set(nodeId);
    this.newSessionDraft.setNodeId(nodeId);
  }

  // ---------------------------------------------------------------------------
  // Send message / session creation
  // ---------------------------------------------------------------------------

  /**
   * Validates the selected remote node (if any), then delegates to
   * InstanceStore.createInstanceWithMessage.
   *
   * Returns `true` when the instance was successfully launched, `false`
   * on validation failure or when the store rejects the creation.
   */
  async onWelcomeSendMessage(
    message: string,
    onCreatingChange: (creating: boolean) => void,
  ): Promise<boolean> {
    const workingDir = this.workingDirectory() || '.';
    const provider =
      this.newSessionDraft.provider() ??
      this.providerState.getProviderForCreation();
    const model =
      this.newSessionDraft.model() ??
      this.providerState.getModelForCreation();
    const pendingFolders = this.pendingFolders();
    const finalMessage = this.fileAttachment.prependPendingFolders(
      message,
      pendingFolders,
    );
    const forceNodeId = this.welcomeSelectedNodeId() ?? undefined;

    // Validate selected remote node is still reachable
    let effectiveWorkingDir = workingDir;
    if (forceNodeId) {
      const node = this.remoteNodeStore.nodeById(forceNodeId);
      if (!node || (node.status !== 'connected' && node.status !== 'degraded')) {
        this.store.setError(
          'Selected remote node is no longer connected. Please choose another node or use Local.',
        );
        return false;
      }

      // If the working directory is a local path that doesn't exist on the
      // remote node, fall back to the first browsable root from that node.
      const allowedDirs = node.capabilities?.workingDirectories ?? [];
      const isWorkingDirOnNode = allowedDirs.some(
        (d) =>
          workingDir === d ||
          workingDir.startsWith(d + '/') ||
          workingDir.startsWith(d + '\\'),
      );
      if (!isWorkingDirOnNode && allowedDirs.length > 0) {
        effectiveWorkingDir = allowedDirs[0];
      } else if (!isWorkingDirOnNode) {
        this.store.setError(
          'The current working directory is not available on the remote node. Please browse and select a remote folder first.',
        );
        return false;
      }
    }

    onCreatingChange(true);
    const launched = await this.store.createInstanceWithMessage(
      finalMessage,
      this.pendingFiles(),
      effectiveWorkingDir,
      provider,
      model,
      forceNodeId,
    );

    if (!launched) {
      onCreatingChange(false);
      // Clear node selection so it doesn't leak into the next attempt
      this.welcomeSelectedNodeId.set(null);
      this.newSessionDraft.setNodeId(null);
      return false;
    }

    this.welcomeSelectedNodeId.set(null);
    this.newSessionDraft.setNodeId(null);
    this.newSessionDraft.clearActiveComposer();
    await this.recentDirsService.addDirectory(
      effectiveWorkingDir,
      forceNodeId ? { nodeId: forceNodeId } : undefined,
    );
    return true;
  }

  // ---------------------------------------------------------------------------
  // Folder selection
  // ---------------------------------------------------------------------------

  onSelectWelcomeFolder(folder: string): void {
    if (folder) {
      this.newSessionDraft.setWorkingDirectory(folder);
    }
  }

  // ---------------------------------------------------------------------------
  // Welcome file handling
  // ---------------------------------------------------------------------------

  onWelcomeFilesDropped(files: File[]): void {
    this.newSessionDraft.addPendingFiles(files);
  }

  onWelcomeImagesPasted(images: File[]): void {
    this.newSessionDraft.addPendingFiles(images);
  }

  onWelcomeRemoveFile(file: File): void {
    this.newSessionDraft.removePendingFile(file);
  }

  async onWelcomeFilePathDropped(filePath: string): Promise<void> {
    const files = await this.fileAttachment.loadFilesFromPaths([filePath]);
    if (files.length > 0) {
      this.newSessionDraft.addPendingFiles(files);
    }
  }

  async onWelcomeFilePathsDropped(filePaths: string[]): Promise<void> {
    const files = await this.fileAttachment.loadFilesFromPaths(filePaths);
    if (files.length > 0) {
      this.newSessionDraft.addPendingFiles(files);
    }
  }

  // ---------------------------------------------------------------------------
  // Welcome folder handling
  // ---------------------------------------------------------------------------

  onWelcomeFolderDropped(folderPath: string): void {
    this.newSessionDraft.addPendingFolder(folderPath);
  }

  onWelcomeRemoveFolder(folder: string): void {
    this.newSessionDraft.removePendingFolder(folder);
  }

  // ---------------------------------------------------------------------------
  // Draft management
  // ---------------------------------------------------------------------------

  onWelcomeDiscardDraft(): void {
    this.newSessionDraft.clearActiveComposer();
  }

  // ---------------------------------------------------------------------------
  // Remote browsing
  // ---------------------------------------------------------------------------

  onWelcomeBrowseRemote(nodeId: string): void {
    this.remoteBrowseNodeId.set(nodeId);
    this.remoteBrowseOpen.set(true);
  }

  onRemoteFolderSelected(path: string): void {
    this.newSessionDraft.setWorkingDirectory(path);
    this.remoteBrowseOpen.set(false);

    // Track as recent directory with remote context and pre-select the
    // remote node so the node picker reflects where the folder lives.
    const nodeId = this.remoteBrowseNodeId();
    if (nodeId) {
      void this.recentDirsService.addDirectory(path, { nodeId });
      this.welcomeSelectedNodeId.set(nodeId);
      this.newSessionDraft.setNodeId(nodeId);
    }
  }

  // ---------------------------------------------------------------------------
  // Project context loading
  // ---------------------------------------------------------------------------

  async loadWelcomeProjectContext(workingDirectory: string): Promise<void> {
    const requestId = ++this.welcomeContextRequestId;
    this.isWelcomeProjectContextLoading.set(true);

    try {
      const [recentDirectories, repoResponse] = await Promise.all([
        this.recentDirsService.getDirectories({ sortBy: 'lastAccessed' }),
        this.vcsIpc.vcsIsRepo(workingDirectory),
      ]);

      if (!this.isLatestWelcomeContextRequest(requestId, workingDirectory)) {
        return;
      }

      const recentEntry = this.findRecentDirectoryEntry(
        recentDirectories,
        workingDirectory,
      );
      const repoData = (repoResponse.data ?? null) as {
        isRepo?: boolean;
      } | null;

      if (!repoResponse.success || !repoData?.isRepo) {
        this.welcomeProjectSnapshot.set({
          branch: null,
          hasChanges: false,
          isRepo: false,
          lastAccessed: recentEntry?.lastAccessed ?? null,
        });
        return;
      }

      const statusResponse = await this.vcsIpc.vcsGetStatus(workingDirectory);
      if (!this.isLatestWelcomeContextRequest(requestId, workingDirectory)) {
        return;
      }

      const statusData = (statusResponse.data ?? null) as {
        branch?: string;
        hasChanges?: boolean;
      } | null;

      this.welcomeProjectSnapshot.set({
        branch: statusResponse.success ? (statusData?.branch ?? null) : null,
        hasChanges: statusResponse.success ? !!statusData?.hasChanges : false,
        isRepo: true,
        lastAccessed: recentEntry?.lastAccessed ?? null,
      });
    } finally {
      if (requestId === this.welcomeContextRequestId) {
        this.isWelcomeProjectContextLoading.set(false);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isLatestWelcomeContextRequest(
    requestId: number,
    workingDirectory: string,
  ): boolean {
    return (
      requestId === this.welcomeContextRequestId &&
      !this.store.selectedInstance() &&
      this.workingDirectory() === workingDirectory
    );
  }

  private findRecentDirectoryEntry(
    entries: RecentDirectoryEntry[],
    workingDirectory: string,
  ): RecentDirectoryEntry | null {
    const normalized = this.normalizePathForComparison(workingDirectory);
    return (
      entries.find(
        (entry) =>
          this.normalizePathForComparison(entry.path) === normalized,
      ) ?? null
    );
  }

  private normalizePathForComparison(path: string | null | undefined): string {
    return (path ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  }
}
