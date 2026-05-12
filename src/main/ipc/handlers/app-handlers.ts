/**
 * App-related IPC Handlers
 * Handles app readiness, version info, dialogs, and file system operations
 */

import { execFile, spawn } from 'node:child_process';
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
  FileOpenTerminalPayloadSchema,
  FileReadBytesPayloadSchema,
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

/**
 * Spawn the platform-native terminal application at the given directory.
 *
 * Strategy:
 * - macOS: `open -a Terminal "<dir>"` — opens Terminal.app at the directory.
 * - Windows: prefer Windows Terminal (`wt -d "<dir>"`); fall back to
 *   `cmd.exe /K cd /d "<dir>"`.
 * - Linux: try `x-terminal-emulator` (Debian/Ubuntu alternatives), then
 *   common terminals (gnome-terminal, konsole, xfce4-terminal, xterm).
 *
 * The terminal is detached so the user can keep working in the app and the
 * terminal outlives the orchestrator (handy for long-running shells).
 */
async function openTerminalAtDirectory(
  dirPath: string,
): Promise<{ success: true; terminal: string } | { success: false; message: string }> {
  if (process.platform === 'darwin') {
    try {
      const proc = spawn('/usr/bin/open', ['-a', 'Terminal', dirPath], {
        detached: true,
        stdio: 'ignore',
      });
      proc.unref();
      return { success: true, terminal: 'Terminal' };
    } catch (error) {
      return { success: false, message: (error as Error).message };
    }
  }

  if (process.platform === 'win32') {
    // Try Windows Terminal first (modern, Win10+/Win11 default)
    const wtAttempt = await trySpawn('wt.exe', ['-d', dirPath]);
    if (wtAttempt.success) {
      return { success: true, terminal: 'Windows Terminal' };
    }

    // Fallback to cmd.exe via `start` so the new window is detached
    const cmdAttempt = await trySpawn(
      'cmd.exe',
      ['/c', 'start', '""', '/D', dirPath, 'cmd.exe'],
    );
    if (cmdAttempt.success) {
      return { success: true, terminal: 'Command Prompt' };
    }

    return {
      success: false,
      message: `Failed to launch a terminal. wt: ${wtAttempt.message}; cmd: ${cmdAttempt.message}`,
    };
  }

  // Linux / other unix
  const candidates: { cmd: string; args: (dir: string) => string[]; label: string }[] = [
    { cmd: 'x-terminal-emulator', args: (dir) => ['--working-directory', dir], label: 'x-terminal-emulator' },
    { cmd: 'gnome-terminal', args: (dir) => [`--working-directory=${dir}`], label: 'GNOME Terminal' },
    { cmd: 'konsole', args: (dir) => ['--workdir', dir], label: 'Konsole' },
    { cmd: 'xfce4-terminal', args: (dir) => [`--working-directory=${dir}`], label: 'Xfce Terminal' },
    { cmd: 'alacritty', args: (dir) => ['--working-directory', dir], label: 'Alacritty' },
    { cmd: 'kitty', args: (dir) => ['--directory', dir], label: 'kitty' },
    { cmd: 'tilix', args: (dir) => ['--working-directory', dir], label: 'Tilix' },
    { cmd: 'xterm', args: (dir) => ['-e', `cd "${dir.replace(/"/g, '\\"')}" && exec $SHELL`], label: 'xterm' },
  ];

  const errors: string[] = [];
  for (const candidate of candidates) {
    const attempt = await trySpawn(candidate.cmd, candidate.args(dirPath));
    if (attempt.success) {
      return { success: true, terminal: candidate.label };
    }
    errors.push(`${candidate.cmd}: ${attempt.message}`);
  }

  return {
    success: false,
    message: `No supported terminal emulator was found. Tried: ${errors.join('; ')}`,
  };
}

/**
 * Try to spawn a detached process; resolves true if the spawn succeeded
 * (i.e. the binary exists and didn't synchronously error). Used by
 * `openTerminalAtDirectory` to walk a fallback list cleanly.
 */
function trySpawn(
  cmd: string,
  args: string[],
): Promise<{ success: true } | { success: false; message: string }> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      let settled = false;
      proc.once('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ success: false, message: err.message });
      });
      proc.once('spawn', () => {
        if (settled) return;
        settled = true;
        proc.unref();
        resolve({ success: true });
      });
    } catch (error) {
      resolve({ success: false, message: (error as Error).message });
    }
  });
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

  // Read file content as raw bytes (base64-encoded) — with path validation.
  // Used for renderer-side File/Blob construction without violating CSP via file:// fetch.
  ipcMain.handle(
    IPC_CHANNELS.FILE_READ_BYTES,
    validatedHandler(
      IPC_CHANNELS.FILE_READ_BYTES,
      FileReadBytesPayloadSchema,
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
          Math.min(payload.maxBytes ?? 50_000_000, 50_000_000)
        );
        const buf = await fs.readFile(pathResult.resolved);
        const truncated = buf.byteLength > maxBytes;
        const contentBuf = truncated ? buf.subarray(0, maxBytes) : buf;

        return {
          success: true,
          data: {
            path: payload.path,
            base64: contentBuf.toString('base64'),
            byteLength: contentBuf.byteLength,
            totalSize: buf.byteLength,
            truncated
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

  // Open the system terminal at the given directory.
  // Mirrors the "Open in Terminal" affordance seen in editors like VS Code/
  // Cursor and matches the Codex desktop app's terminal button.
  ipcMain.handle(
    IPC_CHANNELS.FILE_OPEN_TERMINAL,
    validatedHandler(
      IPC_CHANNELS.FILE_OPEN_TERMINAL,
      FileOpenTerminalPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const fs = await import('fs/promises');
        const nodePath = await import('path');
        const resolvedPath = nodePath.resolve(payload.path);

        // Make sure the path exists and is a directory before spawning.
        try {
          const stats = await fs.stat(resolvedPath);
          if (!stats.isDirectory()) {
            return {
              success: false,
              error: {
                code: 'PATH_NOT_DIRECTORY',
                message: `Not a directory: ${resolvedPath}`,
                timestamp: Date.now(),
              },
            };
          }
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PATH_NOT_FOUND',
              message: `Directory does not exist: ${resolvedPath} (${(error as Error).message})`,
              timestamp: Date.now(),
            },
          };
        }

        const result = await openTerminalAtDirectory(resolvedPath);
        if (!result.success) {
          return {
            success: false,
            error: {
              code: 'TERMINAL_OPEN_FAILED',
              message: result.message,
              timestamp: Date.now(),
            },
          };
        }
        return {
          success: true,
          data: { terminal: result.terminal, path: resolvedPath },
        };
      },
    ),
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
