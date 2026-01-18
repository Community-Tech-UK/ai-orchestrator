/**
 * External Editor Integration - Open files in user's preferred editor (9.2)
 *
 * Supports opening files in VS Code, vim, emacs, and other editors.
 */

import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Supported editor types
 */
export type EditorType =
  | 'vscode'
  | 'vscode-insiders'
  | 'cursor'
  | 'sublime'
  | 'atom'
  | 'vim'
  | 'nvim'
  | 'emacs'
  | 'nano'
  | 'notepad++'
  | 'custom';

/**
 * Editor configuration
 */
export interface EditorConfig {
  type: EditorType;
  path?: string;           // Custom editor path
  args?: string[];         // Additional arguments
  waitForClose?: boolean;  // Wait for editor to close
  useTerminal?: boolean;   // Open in terminal (for vim, nano, etc.)
}

/**
 * Editor detection result
 */
export interface EditorInfo {
  type: EditorType;
  name: string;
  path: string;
  available: boolean;
}

/**
 * File open options
 */
export interface FileOpenOptions {
  line?: number;
  column?: number;
  waitForClose?: boolean;
  newWindow?: boolean;
}

/**
 * Known editor configurations
 */
const EDITOR_CONFIGS: Record<EditorType, {
  names: string[];
  paths: Record<string, string[]>;
  binNames: string[];  // Binary names to search in PATH
  lineArg: (line: number, col?: number) => string[];
  waitArg?: string[];
}> = {
  'vscode': {
    names: ['Visual Studio Code', 'VS Code'],
    paths: {
      darwin: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
      linux: ['/usr/bin/code', '/usr/local/bin/code'],
      win32: ['C:\\Program Files\\Microsoft VS Code\\Code.exe'],
    },
    binNames: ['code'],
    lineArg: (line, col) => col ? [`--goto`, `:{line}:${col}`] : [`--goto`, `:{line}`],
    waitArg: ['--wait'],
  },
  'vscode-insiders': {
    names: ['VS Code Insiders'],
    paths: {
      darwin: ['/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders'],
      linux: ['/usr/bin/code-insiders'],
      win32: ['C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe'],
    },
    binNames: ['code-insiders'],
    lineArg: (line, col) => col ? [`--goto`, `:{line}:${col}`] : [`--goto`, `:{line}`],
    waitArg: ['--wait'],
  },
  'cursor': {
    names: ['Cursor'],
    paths: {
      darwin: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor'],
      linux: ['/usr/bin/cursor'],
      win32: ['C:\\Program Files\\Cursor\\Cursor.exe'],
    },
    binNames: ['cursor'],
    lineArg: (line, col) => col ? [`--goto`, `:{line}:${col}`] : [`--goto`, `:{line}`],
    waitArg: ['--wait'],
  },
  'sublime': {
    names: ['Sublime Text'],
    paths: {
      darwin: ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'],
      linux: ['/usr/bin/subl', '/usr/local/bin/subl'],
      win32: ['C:\\Program Files\\Sublime Text\\subl.exe'],
    },
    binNames: ['subl'],
    lineArg: (line, col) => col ? [`:${line}:${col}`] : [`:${line}`],
    waitArg: ['--wait'],
  },
  'atom': {
    names: ['Atom'],
    paths: {
      darwin: ['/Applications/Atom.app/Contents/Resources/app/atom.sh'],
      linux: ['/usr/bin/atom'],
      win32: ['C:\\Users\\*\\AppData\\Local\\atom\\atom.exe'],
    },
    binNames: ['atom'],
    lineArg: (line, col) => col ? [`:${line}:${col}`] : [`:${line}`],
    waitArg: ['--wait'],
  },
  'vim': {
    names: ['Vim'],
    paths: {
      darwin: ['/usr/bin/vim', '/usr/local/bin/vim'],
      linux: ['/usr/bin/vim'],
      win32: ['C:\\Program Files\\Vim\\vim90\\vim.exe'],
    },
    binNames: ['vim'],
    lineArg: (line) => [`+${line}`],
  },
  'nvim': {
    names: ['Neovim'],
    paths: {
      darwin: ['/usr/local/bin/nvim', '/opt/homebrew/bin/nvim'],
      linux: ['/usr/bin/nvim'],
      win32: ['C:\\Program Files\\Neovim\\bin\\nvim.exe'],
    },
    binNames: ['nvim'],
    lineArg: (line) => [`+${line}`],
  },
  'emacs': {
    names: ['Emacs'],
    paths: {
      darwin: ['/Applications/Emacs.app/Contents/MacOS/Emacs', '/usr/local/bin/emacs'],
      linux: ['/usr/bin/emacs'],
      win32: ['C:\\Program Files\\Emacs\\bin\\emacs.exe'],
    },
    binNames: ['emacs'],
    lineArg: (line) => [`+${line}`],
  },
  'nano': {
    names: ['Nano'],
    paths: {
      darwin: ['/usr/bin/nano'],
      linux: ['/usr/bin/nano'],
      win32: [],
    },
    binNames: ['nano'],
    lineArg: (line) => [`+${line}`],
  },
  'notepad++': {
    names: ['Notepad++'],
    paths: {
      darwin: [],
      linux: [],
      win32: ['C:\\Program Files\\Notepad++\\notepad++.exe', 'C:\\Program Files (x86)\\Notepad++\\notepad++.exe'],
    },
    binNames: ['notepad++'],
    lineArg: (line) => [`-n${line}`],
  },
  'custom': {
    names: ['Custom Editor'],
    paths: { darwin: [], linux: [], win32: [] },
    binNames: [],
    lineArg: () => [],
  },
};

/**
 * Terminal-based editors that need special handling
 */
const TERMINAL_EDITORS: EditorType[] = ['vim', 'nvim', 'emacs', 'nano'];

/**
 * External Editor Manager
 */
export class ExternalEditorManager {
  private preferredEditor: EditorConfig | null = null;
  private availableEditors: EditorInfo[] = [];
  private detected: boolean = false;

  /**
   * Detect available editors on the system
   */
  async detectEditors(): Promise<EditorInfo[]> {
    if (this.detected) {
      return this.availableEditors;
    }

    const platform = os.platform() as 'darwin' | 'linux' | 'win32';
    const editors: EditorInfo[] = [];

    for (const [type, config] of Object.entries(EDITOR_CONFIGS)) {
      if (type === 'custom') continue;

      const paths = config.paths[platform] || [];

      for (const editorPath of paths) {
        // Check if path exists
        if (fs.existsSync(editorPath)) {
          editors.push({
            type: type as EditorType,
            name: config.names[0],
            path: editorPath,
            available: true,
          });
          break;  // Found this editor, move to next type
        }
      }

      // Also check PATH using 'which' or 'where' with execFile for safety
      const cmd = platform === 'win32' ? 'where' : 'which';

      for (const binName of config.binNames) {
        try {
          const result = await this.execFilePromise(cmd, [binName]);
          if (result.trim()) {
            const existingIndex = editors.findIndex((e) => e.type === type);
            if (existingIndex === -1) {
              editors.push({
                type: type as EditorType,
                name: config.names[0],
                path: result.trim().split('\n')[0],
                available: true,
              });
            }
            break;
          }
        } catch {
          // Editor not in PATH
        }
      }
    }

    this.availableEditors = editors;
    this.detected = true;

    // Auto-select preferred editor
    this.autoSelectPreferredEditor();

    return editors;
  }

  /**
   * Execute command with promise using execFile (safer than exec)
   */
  private execFilePromise(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }

  /**
   * Auto-select the best available editor
   */
  private autoSelectPreferredEditor(): void {
    // Check environment variables first
    const envEditor = process.env['VISUAL'] || process.env['EDITOR'];
    if (envEditor) {
      const editorName = path.basename(envEditor).toLowerCase();
      for (const [type] of Object.entries(EDITOR_CONFIGS)) {
        if (editorName.includes(type)) {
          this.preferredEditor = {
            type: type as EditorType,
            path: envEditor,
          };
          return;
        }
      }
      // Custom editor from env
      this.preferredEditor = {
        type: 'custom',
        path: envEditor,
      };
      return;
    }

    // Prefer GUI editors over terminal editors
    const guiEditors = this.availableEditors.filter(
      (e) => !TERMINAL_EDITORS.includes(e.type)
    );

    if (guiEditors.length > 0) {
      // Prefer VS Code family
      const vscode = guiEditors.find((e) => e.type.includes('vscode') || e.type === 'cursor');
      if (vscode) {
        this.preferredEditor = { type: vscode.type, path: vscode.path };
        return;
      }
      this.preferredEditor = { type: guiEditors[0].type, path: guiEditors[0].path };
    } else if (this.availableEditors.length > 0) {
      const editor = this.availableEditors[0];
      this.preferredEditor = { type: editor.type, path: editor.path, useTerminal: true };
    }
  }

  /**
   * Set the preferred editor
   */
  setPreferredEditor(config: EditorConfig): void {
    this.preferredEditor = config;
  }

  /**
   * Get the preferred editor
   */
  getPreferredEditor(): EditorConfig | null {
    return this.preferredEditor;
  }

  /**
   * Get available editors
   */
  getAvailableEditors(): EditorInfo[] {
    return [...this.availableEditors];
  }

  /**
   * Open a file in the editor
   */
  async openFile(
    filePath: string,
    options: FileOpenOptions = {}
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.detected) {
      await this.detectEditors();
    }

    if (!this.preferredEditor) {
      return { success: false, error: 'No editor configured' };
    }

    const editor = this.preferredEditor;
    const editorConfig = EDITOR_CONFIGS[editor.type];
    const editorPath = editor.path || this.availableEditors.find((e) => e.type === editor.type)?.path;

    if (!editorPath) {
      return { success: false, error: `Editor ${editor.type} not found` };
    }

    // Build arguments
    const args: string[] = [...(editor.args || [])];

    // Add wait argument if requested
    if (options.waitForClose && editorConfig.waitArg) {
      args.push(...editorConfig.waitArg);
    }

    // Add new window argument for VS Code
    if (options.newWindow && editor.type.includes('vscode')) {
      args.push('--new-window');
    }

    // Build the file path with line/column
    let fileArg = filePath;
    if (options.line && editorConfig.lineArg) {
      const lineArgs = editorConfig.lineArg(options.line, options.column);
      if (editor.type === 'sublime' || editor.type === 'atom') {
        // Append to file path
        fileArg = `${filePath}${lineArgs[0]}`;
      } else if (editor.type.includes('vscode') || editor.type === 'cursor') {
        // VS Code uses --goto file:line:col
        args.push('--goto', `${filePath}:${options.line}${options.column ? ':' + options.column : ''}`);
        fileArg = '';  // File is included in --goto
      } else {
        // Prepend as arguments (vim style)
        args.push(...lineArgs);
      }
    }

    if (fileArg) {
      args.push(fileArg);
    }

    try {
      const proc = spawn(editorPath, args, {
        detached: !options.waitForClose,
        stdio: 'ignore',
      });

      if (!options.waitForClose) {
        proc.unref();
        return { success: true };
      }

      // Wait for editor to close
      return new Promise((resolve) => {
        proc.on('close', (code) => {
          resolve({ success: code === 0 });
        });
        proc.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
      });
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Open a file at a specific line
   */
  async openFileAtLine(
    filePath: string,
    line: number,
    column?: number
  ): Promise<{ success: boolean; error?: string }> {
    return this.openFile(filePath, { line, column });
  }

  /**
   * Open a directory/folder
   */
  async openDirectory(
    dirPath: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.detected) {
      await this.detectEditors();
    }

    if (!this.preferredEditor) {
      return { success: false, error: 'No editor configured' };
    }

    const editorPath = this.preferredEditor.path ||
      this.availableEditors.find((e) => e.type === this.preferredEditor!.type)?.path;

    if (!editorPath) {
      return { success: false, error: 'Editor not found' };
    }

    try {
      const proc = spawn(editorPath, [dirPath], {
        detached: true,
        stdio: 'ignore',
      });
      proc.unref();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if file was modified after opening
   */
  watchForChanges(
    filePath: string,
    callback: (changed: boolean, newContent?: string) => void
  ): () => void {
    const originalStat = fs.statSync(filePath);
    const originalMtime = originalStat.mtimeMs;

    const watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        const newStat = fs.statSync(filePath);
        if (newStat.mtimeMs !== originalMtime) {
          const content = fs.readFileSync(filePath, 'utf-8');
          callback(true, content);
        }
      }
    });

    return () => watcher.close();
  }
}

// Singleton instance
let editorManagerInstance: ExternalEditorManager | null = null;

export function getExternalEditorManager(): ExternalEditorManager {
  if (!editorManagerInstance) {
    editorManagerInstance = new ExternalEditorManager();
  }
  return editorManagerInstance;
}
