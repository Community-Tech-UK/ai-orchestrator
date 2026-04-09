/**
 * Window Manager - Creates and manages Electron windows
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import { app, BrowserWindow, screen, Menu, Notification, shell, clipboard, nativeImage } from 'electron';
import * as path from 'path';
import { IPC_CHANNELS } from '@contracts/channels';
import { getLogger } from './logging/logger';

const logger = getLogger('WindowManager');
const SAMPLE_DURATION_SECONDS = 5;
const SAMPLE_INTERVAL_MS = 10;

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private isDev: boolean;
  private sampleCaptureInFlight = new Set<number>();

  constructor() {
    this.isDev = process.env['NODE_ENV'] === 'development' || !app.isPackaged;
  }

  async createMainWindow(): Promise<BrowserWindow> {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const isMac = process.platform === 'darwin';

    this.mainWindow = new BrowserWindow({
      width: Math.min(1400, width * 0.9),
      height: Math.min(900, height * 0.9),
      minWidth: 800,
      minHeight: 600,
      title: 'AI Orchestrator',

      // Native appearance - hiddenInset shows traffic lights, hides title
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      titleBarOverlay: !isMac
        ? {
            color: '#1a1a2e',
            symbolColor: '#e4e4e7',
            height: 40
          }
        : undefined,
      trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,

      // Visual
      backgroundColor: '#1a1a2e',
      vibrancy: isMac ? 'under-window' : undefined,
      visualEffectState: isMac ? 'active' : undefined,
      transparent: false,

      // Hide default menu bar on Windows/Linux
      autoHideMenuBar: !isMac,

      // On macOS, hiddenInset provides a frameless look with traffic lights.
      // On Windows/Linux, titleBarOverlay provides native window controls,
      // but requires frame:true (the default) to work — frame:false disables drag.
      frame: !isMac ? true : false,

      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: true // Always enable devtools for debugging
      }
    });

    this.attachWindowDiagnostics(this.mainWindow);

    // Remove menu bar entirely on Windows/Linux for cleaner look
    if (!isMac) {
      this.mainWindow.setMenu(null);
    } else {
      // Create a proper macOS menu
      this.createMacMenu();
    }

    // Load the app
    if (this.isDev) {
      // Development: load from Angular dev server
      // Check both ports in case start:fresh was used
      const port = process.env['PORT'] || '4567';
      await this.mainWindow.loadURL(`http://localhost:${port}`);

      // Don't auto-open DevTools - user can open with Cmd+Option+I if needed
      // this.mainWindow.webContents.openDevTools();
    } else {
      // Production: load built files
      await this.mainWindow.loadFile(
        path.join(__dirname, '../renderer/browser/index.html')
      );
    }

    // Handle window closed
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    // Show context menu on right-click (Electron doesn't show one by default)
    this.mainWindow.webContents.on('context-menu', (_event, params) => {
      const menuItems: Electron.MenuItemConstructorOptions[] = [];

      if (params.mediaType === 'image' && params.srcURL) {
        menuItems.push({
          label: 'Copy Image',
          click: () => {
            const image = nativeImage.createFromDataURL(params.srcURL);
            clipboard.writeImage(image);
          }
        });
      }

      if (params.selectionText) {
        menuItems.push(
          { role: 'copy' },
        );
      }

      if (params.isEditable) {
        menuItems.push(
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        );
      }

      if (menuItems.length > 0) {
        const contextMenu = Menu.buildFromTemplate(menuItems);
        contextMenu.popup();
      }
    });

    // Prevent navigation to external URLs
    this.mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('http://localhost:') && !url.startsWith('file://')) {
        event.preventDefault();
      }
    });

    // Open external links in default browser
    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    return this.mainWindow;
  }

  private attachWindowDiagnostics(window: BrowserWindow): void {
    window.on('unresponsive', () => {
      const diagnostics = this.getWindowDiagnostics(window);
      logger.error('Main window became unresponsive', undefined, diagnostics);
      void this.captureWindowSample(window, diagnostics);
    });

    window.on('responsive', () => {
      logger.info('Main window became responsive again', this.getWindowDiagnostics(window));
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      logger.error('Renderer process exited unexpectedly', undefined, {
        ...this.getWindowDiagnostics(window),
        reason: details.reason,
        exitCode: details.exitCode,
      });
    });

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logger.error('Window failed to load content', undefined, {
        ...this.getWindowDiagnostics(window),
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
    });
  }

  private getWindowDiagnostics(window: BrowserWindow): Record<string, unknown> {
    const webContents = window.webContents;
    let rendererPid: number | null = null;

    try {
      rendererPid = webContents.getOSProcessId();
    } catch {
      rendererPid = null;
    }

    return {
      windowId: window.id,
      rendererPid,
      url: webContents.getURL(),
      isVisible: window.isVisible(),
      isFocused: window.isFocused(),
      bounds: window.getBounds(),
    };
  }

  private async captureWindowSample(
    window: BrowserWindow,
    diagnostics: Record<string, unknown>
  ): Promise<void> {
    if (process.platform !== 'darwin') {
      return;
    }

    const { rendererPid, windowId } = diagnostics;
    if (typeof rendererPid !== 'number' || rendererPid <= 0) {
      logger.warn('Skipping sample capture because renderer pid is unavailable', diagnostics);
      return;
    }

    if (this.sampleCaptureInFlight.has(window.id)) {
      logger.debug('Sample capture already in progress for window', {
        windowId,
        rendererPid,
      });
      return;
    }

    const samplePath = this.getWindowSamplePath(window.id, rendererPid);
    this.sampleCaptureInFlight.add(window.id);

    try {
      await fs.promises.mkdir(path.dirname(samplePath), { recursive: true });

      logger.warn('Capturing renderer sample for unresponsive window', {
        windowId,
        rendererPid,
        samplePath,
        durationSeconds: SAMPLE_DURATION_SECONDS,
        samplingIntervalMs: SAMPLE_INTERVAL_MS,
      });

      await new Promise<void>((resolve, reject) => {
        execFile(
          'sample',
          [
            String(rendererPid),
            String(SAMPLE_DURATION_SECONDS),
            String(SAMPLE_INTERVAL_MS),
            '-mayDie',
            '-file',
            samplePath,
          ],
          (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          }
        );
      });

      logger.warn('Captured renderer sample for unresponsive window', {
        windowId,
        rendererPid,
        samplePath,
      });
    } catch (error) {
      logger.error(
        'Failed to capture renderer sample for unresponsive window',
        error instanceof Error ? error : undefined,
        {
          windowId,
          rendererPid,
          samplePath,
        }
      );
    } finally {
      this.sampleCaptureInFlight.delete(window.id);
    }
  }

  private getWindowSamplePath(windowId: number, rendererPid: number): string {
    return path.join(
      app.getPath('userData'),
      'diagnostics',
      'samples',
      `window-${windowId}-renderer-${rendererPid}-${Date.now()}.sample.txt`
    );
  }

  private createMacMenu(): void {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: 'File',
        submenu: [
          {
            label: 'New Instance',
            accelerator: 'CmdOrCtrl+N',
            click: () => {
              this.mainWindow?.webContents.send(IPC_CHANNELS.MENU_NEW_INSTANCE);
            }
          },
          { type: 'separator' },
          { role: 'close' }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' }
        ]
      }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  sendToRenderer(channel: string, ...args: unknown[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args);
    }
  }

  isMainWindowFocused(): boolean {
    return this.mainWindow?.isFocused() ?? false;
  }

  notifyUserActionRequest(title: string, body: string): void {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title,
        body,
        urgency: 'normal'
      });

      notification.on('click', () => {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
        if (this.mainWindow.isMinimized()) {
          this.mainWindow.restore();
        }
        this.mainWindow.show();
        this.mainWindow.focus();
      });

      notification.show();
    }

    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.mainWindow.isFocused()) return;

    this.mainWindow.flashFrame(true);
    const stopFlash = () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.flashFrame(false);
      }
    };

    this.mainWindow.once('focus', stopFlash);
    setTimeout(stopFlash, 15000);

    if (process.platform === 'darwin' && app.dock) {
      const bounceId = app.dock.bounce('informational');
      this.mainWindow.once('focus', () => app.dock?.cancelBounce(bounceId));
      setTimeout(() => app.dock?.cancelBounce(bounceId), 15000);
    }
  }
}
