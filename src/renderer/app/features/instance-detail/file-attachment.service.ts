import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, FileIpcService } from '../../core/services/ipc';

const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  hpp: 'text/x-c++',
  sh: 'text/x-shellscript',
  xml: 'application/xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function guessMimeType(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

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
   * Loads File objects from a list of absolute file paths via IPC.
   * IPC is used (rather than `fetch('file://...')`) because the renderer
   * Content Security Policy blocks `file:` connections.
   */
  async loadFilesFromPaths(filePaths: string[]): Promise<File[]> {
    const files: File[] = [];
    for (const filePath of filePaths) {
      try {
        const result = await this.fileIpc.readFileBytes(filePath);
        if (!result) {
          console.warn(`Failed to load file: ${filePath}`);
          continue;
        }
        const fileName = filePath.split(/[/\\]/).pop() || 'file';
        const mimeType = guessMimeType(fileName);
        const file = new File([result.buffer], fileName, { type: mimeType });
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
