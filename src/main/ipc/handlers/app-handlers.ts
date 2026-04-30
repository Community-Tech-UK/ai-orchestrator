/**
 * App-related IPC Handlers
 * Handles app readiness, version info, dialogs, and file system operations
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ipcMain, dialog, shell, clipboard } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { WindowManager } from '../../window-manager';
import { validatedHandler } from '../validated-handler';
import { validatePath } from '../../security/path-validator';
import {
  AppOpenDocsPayloadSchema,
  DialogSelectFilesPayloadSchema,
  FileCopyToClipboardPayloadSchema,
  FileGetStatsPayloadSchema,
  FileOpenPathPayloadSchema,
  FileReadDirPayloadSchema,
  FileReadTextPayloadSchema,
  FileWriteTextPayloadSchema,
} from '@contracts/schemas/file-operations';
import { getCapabilityProbe } from '../../bootstrap/capability-probe';

const execFileAsync = promisify(execFile);

interface AppHandlerDependencies {
  windowManager: WindowManager;
  getIpcAuthToken: () => string;
}

function isPathInside(parentPath: string, childPath: string, nodePath: typeof import('path')): boolean {
  const relative = nodePath.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative));
}

function normalizeDocsFilename(filename: string, nodePath: typeof import('path')): string | null {
  const normalized = filename.replace(/\\/g, '/');
  if (nodePath.isAbsolute(normalized)) {
    return null;
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }

  return segments.join(nodePath.sep);
}

function docsRootCandidates(
  nodePath: typeof import('path'),
  appPath: string,
): string[] {
  const roots = [
    nodePath.join(process.cwd(), 'docs'),
    ...(process.resourcesPath ? [nodePath.join(process.resourcesPath, 'docs')] : []),
    nodePath.join(appPath, 'docs'),
    nodePath.resolve(__dirname, '../../../../docs'),
    nodePath.resolve(__dirname, '../../../docs'),
  ];
  return Array.from(new Set(roots.map((root) => nodePath.resolve(root))));
}

async function copyFileReferenceToClipboard(filePath: string): Promise<'native' | 'uri-list'> {
  if (process.platform === 'darwin') {
    await execFileAsync('/usr/bin/osascript', [
      '-e',
      'on run argv',
      '-e',
      'set the clipboard to (POSIX file (item 1 of argv) as alias)',
      '-e',
      'end run',
      filePath,
    ]);
    return 'native';
  }

  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-STA',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$paths = New-Object System.Collections.Specialized.StringCollection;',
        '[void]$paths.Add($args[0]);',
        '[System.Windows.Forms.Clipboard]::SetFileDropList($paths);',
      ].join(' '),
      filePath,
    ]);
    return 'native';
  }

  const fileUrl = pathToFileURL(filePath).href;
  clipboard.writeText(filePath);
  clipboard.writeBuffer('text/uri-list', Buffer.from(`${fileUrl}\n`, 'utf8'));
  clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from(`copy\n${fileUrl}\n`, 'utf8'));
  return 'uri-list';
}

export function registerAppHandlers(deps: AppHandlerDependencies): void {
  const { getIpcAuthToken } = deps;

  // App ready signal — no payload, keep plain
  ipcMain.handle(IPC_CHANNELS.APP_READY, async (event): Promise<IpcResponse> => {
    const startupCapabilities =
      getCapabilityProbe().getLastReport()
      ?? await getCapabilityProbe().run();

    event.sender.send(IPC_CHANNELS.APP_STARTUP_CAPABILITIES, startupCapabilities);
    return {
      success: true,
      data: {
        version: '0.1.0',
        platform: process.platform,
        ipcAuthToken: getIpcAuthToken()
      }
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.APP_GET_STARTUP_CAPABILITIES,
    async (): Promise<IpcResponse> => {
      try {
        const report =
          getCapabilityProbe().getLastReport()
          ?? await getCapabilityProbe().run();
        return {
          success: true,
          data: report,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'APP_GET_STARTUP_CAPABILITIES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // Get app version — no payload, keep plain
  ipcMain.handle(
    IPC_CHANNELS.APP_GET_VERSION,
    async (): Promise<IpcResponse> => {
      return {
        success: true,
        data: '0.1.0'
      };
    }
  );

  // Open a documentation file
  ipcMain.handle(
    IPC_CHANNELS.APP_OPEN_DOCS,
    validatedHandler(
      IPC_CHANNELS.APP_OPEN_DOCS,
      AppOpenDocsPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const nodePath = await import('path');
        const { app } = await import('electron');
        const fs = await import('fs');
        const relativeDocsPath = normalizeDocsFilename(payload.filename, nodePath);

        if (!relativeDocsPath) {
          return {
            success: false,
            error: {
              code: 'DOCS_PATH_INVALID',
              message: `Documentation path is invalid: ${payload.filename}`,
              timestamp: Date.now()
            }
          };
        }

        // Find first existing path
        let docsPath: string | null = null;
        for (const root of docsRootCandidates(nodePath, app.getAppPath())) {
          const p = nodePath.resolve(root, relativeDocsPath);
          if (isPathInside(root, p, nodePath) && fs.existsSync(p)) {
            docsPath = p;
            break;
          }
        }

        if (!docsPath) {
          return {
            success: false,
            error: {
              code: 'FILE_NOT_FOUND',
              message: `Documentation file not found: ${payload.filename}`,
              timestamp: Date.now()
            }
          };
        }

        const result = await shell.openPath(docsPath);
        if (result) {
          return {
            success: false,
            error: {
              code: 'FILE_OPEN_FAILED',
              message: result,
              timestamp: Date.now()
            }
          };
        }
        return { success: true };
      }
    )
  );

  // Note: CLI detection handlers (cli:detect-all, cli:detect-one, cli:test-connection)
  // are registered in cli-verification-ipc-handler.ts with more complete implementation

  // Open folder selection dialog — no payload, keep plain
  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SELECT_FOLDER,
    async (): Promise<IpcResponse> => {
      try {
        const result = await dialog.showOpenDialog({
          properties: ['openDirectory'],
          title: 'Select Working Folder',
          buttonLabel: 'Select Folder'
        });

        if (result.canceled || result.filePaths.length === 0) {
          return {
            success: true,
            data: null // User cancelled
          };
        }

        return {
          success: true,
          data: result.filePaths[0]
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DIALOG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Open file selection dialog — optional payload
  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SELECT_FILES,
    validatedHandler(
      IPC_CHANNELS.DIALOG_SELECT_FILES,
      DialogSelectFilesPayloadSchema,
      async (options): Promise<IpcResponse> => {
        const properties: ('openFile' | 'multiSelections')[] = ['openFile'];
        if (options?.multiple) {
          properties.push('multiSelections');
        }

        const result = await dialog.showOpenDialog({
          properties,
          defaultPath: options?.defaultPath || undefined,
          title: options?.multiple ? 'Select Files' : 'Select File',
          buttonLabel: 'Select',
          filters: options?.filters || [
            { name: 'All Files', extensions: ['*'] },
            {
              name: 'Images',
              extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']
            },
            {
              name: 'Documents',
              extensions: ['pdf', 'txt', 'md', 'json', 'csv']
            },
            {
              name: 'Code',
              extensions: [
                'ts',
                'js',
                'py',
                'go',
                'rs',
                'java',
                'cpp',
                'c',
                'h'
              ]
            }
          ]
        });

        if (result.canceled || result.filePaths.length === 0) {
          return {
            success: true,
            data: null // User cancelled
          };
        }

        return {
          success: true,
          data: result.filePaths
        };
      }
    )
  );

  // Read directory contents
  ipcMain.handle(
    IPC_CHANNELS.FILE_READ_DIR,
    validatedHandler(
      IPC_CHANNELS.FILE_READ_DIR,
      FileReadDirPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const fs = await import('fs/promises');
        const nodePath = await import('path');

        const entries = await fs.readdir(payload.path, {
          withFileTypes: true
        });
        const results = await Promise.all(
          entries
            .filter((entry) => {
              // Filter hidden files unless explicitly included
              if (!payload.includeHidden && entry.name.startsWith('.')) {
                return false;
              }
              return true;
            })
            .map(async (entry) => {
              const fullPath = nodePath.join(payload.path, entry.name);
              let stats;
              try {
                stats = await fs.stat(fullPath);
              } catch {
                // Skip files we can't stat
                return null;
              }

              return {
                name: entry.name,
                path: fullPath,
                isDirectory: entry.isDirectory(),
                isSymlink: entry.isSymbolicLink(),
                size: stats.size,
                modifiedAt: stats.mtimeMs,
                extension: entry.isFile()
                  ? nodePath.extname(entry.name).slice(1)
                  : undefined
              };
            })
        );

        // Filter out nulls and sort: directories first, then alphabetically
        const filtered = results.filter((r) => r !== null);
        filtered.sort((a, b) => {
          if (a!.isDirectory && !b!.isDirectory) return -1;
          if (!a!.isDirectory && b!.isDirectory) return 1;
          return a!.name.localeCompare(b!.name);
        });

        return {
          success: true,
          data: filtered
        };
      }
    )
  );

  // Get file stats
  ipcMain.handle(
    IPC_CHANNELS.FILE_GET_STATS,
    validatedHandler(
      IPC_CHANNELS.FILE_GET_STATS,
      FileGetStatsPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const fs = await import('fs/promises');
        const nodePath = await import('path');

        const stats = await fs.stat(payload.path);

        return {
          success: true,
          data: {
            name: nodePath.basename(payload.path),
            path: payload.path,
            isDirectory: stats.isDirectory(),
            isSymlink: stats.isSymbolicLink(),
            size: stats.size,
            modifiedAt: stats.mtimeMs,
            createdAt: stats.birthtimeMs,
            extension: stats.isFile()
              ? nodePath.extname(payload.path).slice(1)
              : undefined
          }
        };
      }
    )
  );

  // Read file content as text (bounded) — with path validation
  ipcMain.handle(
    IPC_CHANNELS.FILE_READ_TEXT,
    validatedHandler(
      IPC_CHANNELS.FILE_READ_TEXT,
      FileReadTextPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const pathResult = validatePath(payload.path);
        if (!pathResult.valid) {
          return {
            success: false,
            error: {
              code: 'PATH_VALIDATION_FAILED',
              message: pathResult.error!,
              timestamp: Date.now()
            }
          };
        }

        const fs = await import('fs/promises');

        const maxBytes = Math.max(
          1,
          Math.min(payload.maxBytes ?? 512 * 1024, 5 * 1024 * 1024)
        );
        const buf = await fs.readFile(pathResult.resolved);
        const truncated = buf.byteLength > maxBytes;
        const contentBuf = truncated ? buf.subarray(0, maxBytes) : buf;

        return {
          success: true,
          data: {
            path: payload.path,
            content: contentBuf.toString('utf-8'),
            truncated,
            size: buf.byteLength
          }
        };
      }
    )
  );

  // Write file content as text — with path validation
  ipcMain.handle(
    IPC_CHANNELS.FILE_WRITE_TEXT,
    validatedHandler(
      IPC_CHANNELS.FILE_WRITE_TEXT,
      FileWriteTextPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const pathResult = validatePath(payload.path);
        if (!pathResult.valid) {
          return {
            success: false,
            error: {
              code: 'PATH_VALIDATION_FAILED',
              message: pathResult.error!,
              timestamp: Date.now()
            }
          };
        }

        const fs = await import('fs/promises');
        const nodePath = await import('path');

        if (payload.createDirs) {
          await fs.mkdir(nodePath.dirname(pathResult.resolved), { recursive: true });
        }

        await fs.writeFile(pathResult.resolved, payload.content ?? '', 'utf-8');
        const bytesWritten = Buffer.byteLength(payload.content ?? '', 'utf-8');
        return {
          success: true,
          data: { path: payload.path, bytesWritten }
        };
      }
    )
  );

  // Open file or folder with system default application
  ipcMain.handle(
    IPC_CHANNELS.FILE_OPEN_PATH,
    validatedHandler(
      IPC_CHANNELS.FILE_OPEN_PATH,
      FileOpenPathPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const result = await shell.openPath(payload.path);
        // shell.openPath returns empty string on success, error message on failure
        if (result) {
          return {
            success: false,
            error: {
              code: 'FILE_OPEN_FAILED',
              message: result,
              timestamp: Date.now()
            }
          };
        }
        return { success: true };
      }
    )
  );

  // Copy file or folder reference to the system clipboard for pasting in Finder/Explorer/files.
  ipcMain.handle(
    IPC_CHANNELS.FILE_COPY_TO_CLIPBOARD,
    validatedHandler(
      IPC_CHANNELS.FILE_COPY_TO_CLIPBOARD,
      FileCopyToClipboardPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const fs = await import('fs/promises');
        const nodePath = await import('path');
        const resolvedPath = nodePath.resolve(payload.path);
        const stats = await fs.stat(resolvedPath);
        const mode = await copyFileReferenceToClipboard(resolvedPath);

        return {
          success: true,
          data: {
            path: resolvedPath,
            isDirectory: stats.isDirectory(),
            mode,
          },
        };
      }
    )
  );
}
