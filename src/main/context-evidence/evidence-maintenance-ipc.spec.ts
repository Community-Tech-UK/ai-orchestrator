import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../shared/types/ipc.types';

const handlers = new Map<string, (event: unknown, input: unknown) => Promise<IpcResponse>>();
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<IpcResponse>) => handlers.set(channel, handler),
  removeHandler: (channel: string) => handlers.delete(channel),
} }));

import { registerContextEvidenceHandlers } from '../ipc/handlers/context-evidence.handlers';
import { createIncidentReplayServices } from './__fixtures__/incident-replay-harness';
import { ContextEvidenceCoordinator } from './context-evidence-coordinator';
import {
  initializeContextEvidenceRuntime, getContextEvidenceRuntime,
  startContextEvidenceMaintenance, stopContextEvidenceMaintenance,
  _resetContextEvidenceRuntimeForTesting,
} from './evidence-maintenance-runtime';

describe('evidence IPC while background maintenance is pending', () => {
  it('captures encrypted evidence and answers validated list IPC before maintenance finishes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evidence-maintenance-ipc-'));
    const services = createIncidentReplayServices({ userDataPath: directory });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const reconcile = vi.spyOn(services.maintenanceService, 'reconcileStartup').mockImplementation(async () => {
      entered = true;
      await pending;
      return { recovered: 0, failed: 0, corrupt: 0, pending: 0, stagingFilesRemoved: 0, finalizedFilesRemoved: 0 };
    });
    let cleanup: (() => void) | undefined;
    try {
      await services.keyManager.initialize();
      await initializeContextEvidenceRuntime(async () => services);
      vi.useFakeTimers();
      startContextEvidenceMaintenance();
      await vi.advanceTimersByTimeAsync(5_000);
      vi.useRealTimers();
      expect(entered).toBe(true);
      expect(getContextEvidenceRuntime().captureService).toBe(services.captureService);
      const capture = await services.captureService.capture({
        conversationId: 'fixture-conversation', captureKey: 'fixture-capture', provider: 'codex',
        toolName: 'fixture-tool', sourceKind: 'other', mimeType: 'text/plain',
        sensitivity: 'normal', provenanceTrust: 'runtime-authenticated', captureMode: 'post-retention',
        captureCompleteness: 'complete', observedBoundary: 'after-provider-retention',
        content: new TextEncoder().encode('obvious encrypted fixture'),
      });
      expect(capture.status).toBe('captured');
      cleanup = registerContextEvidenceHandlers({
        instanceManager: Object.assign(new EventEmitter(), { getInstance: () => undefined, getAllInstances: () => [] }) as never,
        windowManager: { sendToRenderer: () => undefined },
        coordinator: new ContextEvidenceCoordinator(services),
        ledger: { getContextEvidenceConversationMetrics: async () => ({
          evidenceRecordCount: 1, evidenceCardCount: 0, externallyStoredBytes: 0,
          toolCallCount: 0, toolResultBytes: 0, lastActionCode: null, recoveryCount: 0,
        }) },
        getChats: () => [{ id: 'fixture-chat', ledgerThreadId: 'fixture-conversation' } as never],
      });
      const handler = handlers.get(IPC_CHANNELS.CONTEXT_EVIDENCE_LIST)!;
      expect((await handler({}, {})).error?.code).toBe('VALIDATION_FAILED');
      const response = await handler({}, {
        owner: { kind: 'chat', chatId: 'fixture-chat' }, conversationId: 'fixture-conversation',
      });
      expect(response).toMatchObject({ success: true, data: [expect.objectContaining({ status: 'complete' })] });
      expect(reconcile).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      const stopped = stopContextEvidenceMaintenance();
      release();
      await stopped;
      cleanup?.();
      _resetContextEvidenceRuntimeForTesting();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
