/**
 * IPC for the daily Claude cost check.
 *
 * Registering also wires and starts the daily schedule, because the check needs the
 * same cost database the cost handlers open. Neither channel takes a payload, and the
 * reply is the stored snapshot only: totals, session ids and counts, never transcript text.
 */

import { app, ipcMain } from 'electron';
import { homedir } from 'os';
import { IPC_CHANNELS } from '@contracts/channels';
import type { ClaudeCostReconcileSnapshot } from '../../../shared/types/claude-cost-reconcile.types';
import { CLAUDE_PROFILES_ROOT_DIR } from '../../cli/adapters/account-pool/provider-account-home-resolver';
import { loadStoredClaudeSessions, readBookingLiveAt } from '../../core/system/claude-cost-reconcile';
import { getClaudeCostReconcileService, reconcileStatePath } from '../../core/system/claude-cost-reconcile-service';
import { claudeTranscriptRoots } from '../../core/system/claude-cost-state-reader';
import { getLogger } from '../../logging/logger';
import { getRLMDatabase } from '../../persistence/rlm-database';
import { registerCleanup } from '../../util/cleanup-registry';
import type { IpcResponse } from '../validated-handler';

const logger = getLogger('ClaudeCostReconcileHandlers');

export function registerClaudeCostReconcileHandlers(): void {
  const service = getClaudeCostReconcileService();
  try {
    const db = getRLMDatabase().getRawDb();
    const userDataPath = app.getPath('userData');
    service.configure({
      statePath: reconcileStatePath(userDataPath),
      loadSessions: windowStart => loadStoredClaudeSessions(db, windowStart),
      bookingLiveAt: () => readBookingLiveAt(db),
      transcriptRoots: () => claudeTranscriptRoots({
        homeDir: homedir(), userDataPath, profilesDirName: CLAUDE_PROFILES_ROOT_DIR, configDir: process.env['CLAUDE_CONFIG_DIR'],
      }),
    });
    service.start();
    // Stop the schedule, and drop any check still running, when the app shuts down.
    registerCleanup(() => service.shutdown());
  } catch (error) {
    logger.warn('Claude cost check unavailable: the cost database could not be opened', { error: String(error) });
  }

  const reply = (): IpcResponse<ClaudeCostReconcileSnapshot> => ({ success: true, data: service.getSnapshot() });
  const failure = (code: string, error: unknown): IpcResponse => ({
    success: false,
    error: { code, message: error instanceof Error ? error.message : String(error), timestamp: Date.now() },
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_COST_RECONCILE_GET, async (): Promise<IpcResponse> => {
    try { return reply(); } catch (error) { return failure('CLAUDE_COST_RECONCILE_GET_FAILED', error); }
  });
  ipcMain.handle(IPC_CHANNELS.CLAUDE_COST_RECONCILE_RUN, async (): Promise<IpcResponse> => {
    try {
      await service.runNow();
      return reply();
    } catch (error) { return failure('CLAUDE_COST_RECONCILE_RUN_FAILED', error); }
  });
}
