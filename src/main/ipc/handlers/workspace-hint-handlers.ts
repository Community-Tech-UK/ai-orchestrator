/**
 * Workspace Hint IPC Handler
 *
 * Renderer-driven hint that this workspace is the user's current focus.
 * Fans out to every coordinator that subscribes to "workspace is present"
 * events:
 *   - CodememPrewarmCoordinator   (fast AST/LSP warm-up)
 *   - CodebaseIndexingAutoCoordinator (heavier embedding pipeline)
 *   - ProjectKnowledgeAutoMirrorCoordinator (RLM mirror of codemem snapshot)
 *
 * Replaces the per-subsystem `CODEMEM_PREWARM_HINT` + `CODEBASE_AUTO_HINT`
 * channels (consolidated per
 * docs/plans/2026-05-26-project-code-index-bridge-auto-mirror.md). Each
 * coordinator call is wrapped in try/catch so a missing/disabled coordinator
 * is a no-op rather than failing the whole fan-out.
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getLogger } from '../../logging/logger';
import { validateIpcPayload } from '@contracts/schemas/common';
import { WorkspaceHintActivePayloadSchema } from '@contracts/schemas/workspace-tools';
import { getCodememPrewarmCoordinator } from '../../codemem';
import { getCodebaseIndexingAutoCoordinator } from '../../indexing';
import { getProjectKnowledgeAutoMirrorCoordinator } from '../../memory';

const logger = getLogger('WorkspaceHintHandlers');

interface HintFanOutTarget {
  name: string;
  hint: (path: string) => void;
}

/**
 * Each fan-out call is wrapped in try/catch so a coordinator that hasn't
 * been initialised yet (or that throws synchronously) doesn't poison the
 * sibling coordinators. Failures only emit a warning — the hint is best-
 * effort and the spawn-time safety nets remain as the always-fresh path.
 */
function fanOutHint(targets: HintFanOutTarget[], path: string): void {
  for (const target of targets) {
    try {
      target.hint(path);
    } catch (error) {
      logger.warn('Workspace hint fan-out failed for one coordinator', {
        coordinator: target.name,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function registerWorkspaceHintHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_HINT_ACTIVE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse<{ accepted: boolean }>> => {
      try {
        const validated = validateIpcPayload(
          WorkspaceHintActivePayloadSchema,
          payload,
          'WORKSPACE_HINT_ACTIVE',
        );

        // Remote workspaces are owned by their node — skip the local fan-out.
        if (validated.nodeId) {
          return { success: true, data: { accepted: false } };
        }

        // Resolve coordinators lazily — they're singletons created during
        // initialization-steps.ts, and if any of them are deliberately
        // disabled at startup the getter still returns an instance whose
        // `hintActiveWorkspace` is a safe no-op.
        const targets: HintFanOutTarget[] = [
          {
            name: 'codemem-prewarm',
            hint: (p) => getCodememPrewarmCoordinator().hintActiveWorkspace(p),
          },
          {
            name: 'codebase-auto-index',
            hint: (p) => getCodebaseIndexingAutoCoordinator().hintActiveWorkspace(p),
          },
          {
            name: 'project-knowledge-auto-mirror',
            hint: (p) => getProjectKnowledgeAutoMirrorCoordinator().hintActiveWorkspace(p),
          },
        ];

        fanOutHint(targets, validated.path);
        return { success: true, data: { accepted: true } };
      } catch (error) {
        logger.warn('Workspace hint validation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          error: {
            code: 'WORKSPACE_HINT_ACTIVE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
