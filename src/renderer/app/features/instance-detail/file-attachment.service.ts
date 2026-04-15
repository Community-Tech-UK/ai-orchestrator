import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, FileIpcService } from '../../core/services/ipc';

@Injectable({ providedIn: 'root' })
export class FileAttachmentService {
  private ipc = inject(ElectronIpcService);
  private fileIpc = inject(FileIpcService);

  /**
   * Opens a file picker dialog and loads the selected files.
   * Returns an empty array if the user cancels or no files are chosen.
   */
  async selectAndLoadFiles(defaultPath?: string | null): Promise<File[]> {
    const filePaths = await this.ipc.selectFiles({
      multiple: true,
      defaultPath: defaultPath || undefined,
    });
    if (!filePaths || filePaths.length === 0) {
      return [];
    }

    return this.loadFilesFromPaths(filePaths);
  }

  /**
   * Loads File objects from a list of absolute file paths by fetching them
   * via the `file://` protocol.
   */
  async loadFilesFromPaths(filePaths: string[]): Promise<File[]> {
    const files: File[] = [];
    for (const filePath of filePaths) {
      try {
        const response = await fetch(`file://${filePath}`);
        const blob = await response.blob();
        const fileName = filePath.split('/').pop() || 'file';
        const file = new File([blob], fileName, {
          type: blob.type || 'application/octet-stream',
        });
        files.push(file);
      } catch (error) {
        console.warn(`Failed to load file: ${filePath}`, error);
      }
    }
    return files;
  }

  /**
   * Loads File objects from dropped file paths, skipping directories.
   */
  async loadDroppedFilesFromPaths(filePaths: string[]): Promise<File[]> {
    const acceptedPaths: string[] = [];
    for (const filePath of filePaths) {
      const stats = await this.fileIpc.getFileStats(filePath);
      if (!stats) {
        continue;
      }

      if (stats.isDirectory) {
        console.log('Directory dropped - not supported yet:', filePath);
        continue;
      }

      acceptedPaths.push(filePath);
    }

    return this.loadFilesFromPaths(acceptedPaths);
  }

  /**
   * Prepends folder references to a message string.
   * Returns the original message unchanged when the folder list is empty.
   */
  prependPendingFolders(message: string, pendingFolders: string[]): string {
    if (pendingFolders.length === 0) {
      return message;
    }

    const folderRefs = pendingFolders.map((folder) => `[Folder: ${folder}]`).join('\n');
    return message ? `${folderRefs}\n\n${message}` : folderRefs;
  }
}
