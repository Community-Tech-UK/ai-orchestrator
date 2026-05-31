/**
 * Real-world wiring for the LSP post-edit feedback loop (backlog #13).
 *
 * Connects the tested `LspFeedbackCoordinator` to live collaborators:
 *   - diagnostics  ← getLspManager().getDiagnostics (mapped LSP → LspDiagnostic)
 *   - idle check   ← instanceManager.getInstance(id).status
 *   - inject       → instanceManager.sendInput(id, note, …, { autoContinuation })
 *
 * Enablement is a self-contained, in-memory flag (DEFAULT-OFF) toggled over IPC,
 * deliberately NOT in settings.types (owned by a concurrent session). Auto-
 * injecting messages into a live agent is opt-in and should be validated by the
 * operator before turning on.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../shared/types/ipc.types';
import { getLogger } from '../logging/logger';
import { getLspManager } from '../workspace/lsp-manager';
import { LspFeedbackCoordinator, type LspDiagnostic, type LspSeverity } from './lsp-feedback-coordinator';

const logger = getLogger('LspFeedbackReg');

let enabled = false;
let coordinator: LspFeedbackCoordinator | null = null;

export function isLspFeedbackEnabled(): boolean {
  return enabled;
}

export function setLspFeedbackEnabled(value: boolean): void {
  enabled = value;
  logger.info('LSP feedback toggled', { enabled });
}

/** Map an LSP numeric severity (1=Error…4=Hint) to our severity union. */
function mapSeverity(severity: number | undefined): LspSeverity {
  switch (severity) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    default:
      // Unknown/undefined severity is treated as info so it never triggers
      // feedback (only errors do).
      return 'info';
  }
}

interface LspDiagnosticRaw {
  severity?: number;
  message?: string;
  range?: { start?: { line?: number } };
}

/** Minimal instance-manager surface this wiring depends on. */
export interface LspFeedbackInstanceHost {
  getInstance(id: string): { status?: string } | undefined;
  sendInput(
    instanceId: string,
    message: string,
    attachments?: undefined,
    options?: { autoContinuation?: boolean },
  ): Promise<void>;
}

export function registerLspFeedback(deps: { instanceManager: LspFeedbackInstanceHost }): void {
  coordinator = new LspFeedbackCoordinator({
    isEnabled: () => enabled,
    isInstanceIdle: (id) => deps.instanceManager.getInstance(id)?.status === 'idle',
    getDiagnostics: async (filePath): Promise<LspDiagnostic[] | null> => {
      const raw = (await getLspManager().getDiagnostics(filePath)) as LspDiagnosticRaw[] | null;
      if (!raw) return null;
      return raw.map((d) => ({
        severity: mapSeverity(d.severity),
        message: d.message ?? '',
        line: d.range?.start?.line !== undefined ? d.range.start.line + 1 : undefined,
      }));
    },
    injectFeedback: (instanceId, note) =>
      deps.instanceManager.sendInput(instanceId, note, undefined, { autoContinuation: true }),
  });
  coordinator.attach();

  ipcMain.handle(IPC_CHANNELS.LSP_FEEDBACK_GET, async (): Promise<IpcResponse> => {
    return { success: true, data: { enabled } };
  });

  ipcMain.handle(
    IPC_CHANNELS.LSP_FEEDBACK_SET,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      const value = Boolean((payload as { enabled?: unknown } | undefined)?.enabled);
      setLspFeedbackEnabled(value);
      return { success: true, data: { enabled } };
    },
  );
}

/** Drop a terminated instance's accumulated feedback state. */
export function forgetLspFeedbackInstance(instanceId: string): void {
  coordinator?.forgetInstance(instanceId);
}

export function _disposeLspFeedbackForTesting(): void {
  coordinator?.dispose();
  coordinator = null;
  enabled = false;
}
