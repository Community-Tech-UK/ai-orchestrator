/**
 * Project Plugin Trust IPC Handlers (Task 9)
 *
 * Query, grant, and revoke trust for project-scoped plugin roots. Trust
 * decisions are persisted in user-scoped settings (`projectPluginTrust`),
 * never in the project itself, so cloning a hostile repository can never
 * auto-execute its plugins: project plugin code is imported only after an
 * explicit user grant has been written.
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as os from 'node:os';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  ProjectPluginTrustQueryPayloadSchema,
  ProjectPluginTrustRootPayloadSchema,
} from '@contracts/schemas/plugin';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { ProjectPluginTrust } from '../../../shared/types/settings.types';
import { getLogger } from '../../logging/logger';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getOrchestratorPluginManager } from '../../plugins/plugin-manager';
import {
  canonicalizeProjectPluginRoot,
  resolveProjectPluginTrust,
  type ProjectPluginTrustDecision,
} from '../../plugins/project-plugin-trust';
import { resolveProjectScanRoots } from '../../util/project-scan-roots';

const logger = getLogger('ProjectPluginTrustHandlers');

export interface ProjectPluginTrustHandlerDeps {
  /** Read the persisted trust map (user-scoped settings). */
  readTrustMap?: () => Record<string, ProjectPluginTrust>;
  /** Persist the trust map (user-scoped settings — never the project). */
  writeTrustMap?: (map: Record<string, ProjectPluginTrust>) => void;
  /** Clear the plugin cache so the next load re-evaluates trust. */
  clearPluginCache?: () => void;
  homeDir?: string | null;
}

function responseError(code: string, error: unknown): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

export function registerProjectPluginTrustHandlers(
  deps: ProjectPluginTrustHandlerDeps = {},
): void {
  const readTrustMap =
    deps.readTrustMap ?? (() => getSettingsManager().get('projectPluginTrust'));
  const writeTrustMap =
    deps.writeTrustMap
    ?? ((map: Record<string, ProjectPluginTrust>) =>
      getSettingsManager().set('projectPluginTrust', map));
  const clearPluginCache =
    deps.clearPluginCache ?? (() => getOrchestratorPluginManager().clearCache());
  const homeDir = deps.homeDir !== undefined ? deps.homeDir : os.homedir();

  const settingsView = (): { projectPluginTrust: Record<string, ProjectPluginTrust> } => ({
    projectPluginTrust: readTrustMap(),
  });

  const applyTrust = (
    projectRoot: string,
    trust: Extract<ProjectPluginTrust, 'trusted' | 'untrusted'>,
  ): ProjectPluginTrustDecision => {
    const canonicalRoot = canonicalizeProjectPluginRoot(projectRoot);
    // Persist the decision BEFORE any plugin import can happen; clearing the
    // cache makes the next plugin load re-run the trust gate against the
    // freshly written setting (grant activates, revoke deactivates).
    writeTrustMap({ ...readTrustMap(), [canonicalRoot]: trust });
    clearPluginCache();
    logger.info(`Project plugin trust decision recorded: ${trust}`, {
      projectRoot: canonicalRoot,
    });
    return resolveProjectPluginTrust(canonicalRoot, settingsView());
  };

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_PLUGIN_TRUST_QUERY,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ProjectPluginTrustQueryPayloadSchema,
          payload,
          'PROJECT_PLUGIN_TRUST_QUERY',
        );
        const decisions = resolveProjectScanRoots(validated.workingDirectory, homeDir)
          .map((root) => resolveProjectPluginTrust(root, settingsView()));
        return { success: true, data: { decisions } };
      } catch (error) {
        return responseError('PROJECT_PLUGIN_TRUST_QUERY_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_PLUGIN_TRUST_GRANT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ProjectPluginTrustRootPayloadSchema,
          payload,
          'PROJECT_PLUGIN_TRUST_GRANT',
        );
        return { success: true, data: applyTrust(validated.projectRoot, 'trusted') };
      } catch (error) {
        return responseError('PROJECT_PLUGIN_TRUST_GRANT_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_PLUGIN_TRUST_REVOKE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ProjectPluginTrustRootPayloadSchema,
          payload,
          'PROJECT_PLUGIN_TRUST_REVOKE',
        );
        return { success: true, data: applyTrust(validated.projectRoot, 'untrusted') };
      } catch (error) {
        return responseError('PROJECT_PLUGIN_TRUST_REVOKE_FAILED', error);
      }
    },
  );
}
