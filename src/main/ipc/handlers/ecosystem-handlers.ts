/**
 * Ecosystem IPC Handlers
 *
 * Exposes file-based "extensibility" surfaces to the renderer:
 * - Slash commands (markdown)
 * - Custom agents (markdown)
 * - Local tools (CommonJS JS modules)
 * - Plugins (JS hooks)
 *
 * This is intentionally implemented in-repo (no runtime dependency on sibling repos).
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import { EcosystemListPayloadSchema } from '@contracts/schemas/provider';
import type { InstanceManager } from '../../instance/instance-manager';
import { getMarkdownCommandRegistry } from '../../commands/markdown-command-registry';
import { getAgentRegistry } from '../../agents/agent-registry';
import { getToolRegistry } from '../../tools/tool-registry';
import { getOrchestratorPluginManager } from '../../plugins/plugin-manager';
import { BrowserWindow } from 'electron';
import chokidar from 'chokidar';
import { getLogger } from '../../logging/logger';

const logger = getLogger('EcosystemHandlers');

export function registerEcosystemHandlers(instanceManager: InstanceManager): void {
  const watchers = new Map<string, import('chokidar').FSWatcher>();

  async function buildWatchDirs(workingDirectory: string): Promise<string[]> {
    const commands = await getMarkdownCommandRegistry().listCommands(workingDirectory);
    const agents = await getAgentRegistry().listAgents(workingDirectory);
    const tools = await getToolRegistry().listTools(workingDirectory);
    const plugins = await getOrchestratorPluginManager().listPlugins(workingDirectory, instanceManager);

    const dirs = [
      ...commands.scanDirs,
      ...agents.scanDirs,
      ...tools.scanDirs,
      ...plugins.scanDirs,
    ];

    // De-dupe, keep stable order.
    const out: string[] = [];
    const seen = new Set<string>();
    for (const d of dirs) {
      if (!d) continue;
      if (seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
    return out;
  }

  ipcMain.handle(
    IPC_CHANNELS.ECOSYSTEM_LIST,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(EcosystemListPayloadSchema, payload, 'ECOSYSTEM_LIST');
        const workingDirectory = validated.workingDirectory;

        // Ensure edits show up immediately in the UI.
        getMarkdownCommandRegistry().clearCache(workingDirectory);
        getAgentRegistry().clearCache(workingDirectory);
        getToolRegistry().clearCache(workingDirectory);
        getOrchestratorPluginManager().clearCache(workingDirectory);

        const commands = await getMarkdownCommandRegistry().listCommands(
          workingDirectory
        );
        const agents = await getAgentRegistry().listAgents(workingDirectory);
        const tools = await getToolRegistry().listTools(workingDirectory);
        const plugins = await getOrchestratorPluginManager().listPlugins(
          workingDirectory,
          instanceManager
        );

        return {
          success: true,
          data: {
            workingDirectory,
            commands,
            agents,
            tools,
            plugins
          }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ECOSYSTEM_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ECOSYSTEM_WATCH_START,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(EcosystemListPayloadSchema, payload, 'ECOSYSTEM_WATCH_START');
        const wd = validated.workingDirectory;
        if (!wd) return { success: true, data: { watching: false } };
        if (watchers.has(wd)) return { success: true, data: { watching: true } };

        const dirs = await buildWatchDirs(wd);
        const watcher = chokidar.watch(dirs, {
          ignoreInitial: true,
          ignored: ['**/node_modules/**', '**/.git/**'],
          persistent: true,
        });

        const emitChanged = (event: string, filePath: string) => {
          for (const win of BrowserWindow.getAllWindows()) {
            try {
              win.webContents.send(IPC_CHANNELS.ECOSYSTEM_CHANGED, {
                workingDirectory: wd,
                event,
                path: filePath,
                timestamp: Date.now(),
              });
            } catch (error) {
              logger.warn('Failed to send ecosystem changed event to renderer window', { event, filePath, error: error instanceof Error ? error.message : String(error) });
            }
          }
        };

        watcher.on('add', (p) => emitChanged('add', p));
        watcher.on('change', (p) => emitChanged('change', p));
        watcher.on('unlink', (p) => emitChanged('unlink', p));

        watchers.set(wd, watcher);
        return { success: true, data: { watching: true, dirs } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ECOSYSTEM_WATCH_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ECOSYSTEM_WATCH_STOP,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(EcosystemListPayloadSchema, payload, 'ECOSYSTEM_WATCH_STOP');
        const wd = validated.workingDirectory;
        const watcher = wd ? watchers.get(wd) : null;
        if (!watcher) return { success: true, data: { watching: false } };
        watchers.delete(wd);
        await watcher.close();
        return { success: true, data: { watching: false } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ECOSYSTEM_WATCH_STOP_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
