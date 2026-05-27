/**
 * Workspace hint handler tests.
 *
 * The unified `WORKSPACE_HINT_ACTIVE` channel replaces the per-subsystem
 * `CODEMEM_PREWARM_HINT` and `CODEBASE_AUTO_HINT` channels. The handler must:
 *   - Validate the payload (path required)
 *   - Skip the fan-out for remote workspaces (nodeId present)
 *   - Fan the hint out to every coordinator independently — one failure
 *     should not poison the siblings
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';

// ─── Mock electron ──────────────────────────────────────────────────────────

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

// ─── Mock the three coordinator singletons ──────────────────────────────────

const codememHint = vi.fn();
const codebaseHint = vi.fn();
const projectKnowledgeHint = vi.fn();

vi.mock('../../../codemem', () => ({
  getCodememPrewarmCoordinator: () => ({
    hintActiveWorkspace: (...args: unknown[]) => codememHint(...args),
  }),
}));

vi.mock('../../../indexing', () => ({
  getCodebaseIndexingAutoCoordinator: () => ({
    hintActiveWorkspace: (...args: unknown[]) => codebaseHint(...args),
  }),
}));

vi.mock('../../../memory', () => ({
  getProjectKnowledgeAutoMirrorCoordinator: () => ({
    hintActiveWorkspace: (...args: unknown[]) => projectKnowledgeHint(...args),
  }),
}));

import { registerWorkspaceHintHandlers } from '../workspace-hint-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';

describe('workspace-hint handlers', () => {
  beforeEach(() => {
    handlers.clear();
    codememHint.mockReset();
    codebaseHint.mockReset();
    projectKnowledgeHint.mockReset();
    registerWorkspaceHintHandlers();
  });

  it('fans the hint out to all three coordinators for a local path', async () => {
    const handler = handlers.get(IPC_CHANNELS.WORKSPACE_HINT_ACTIVE);
    expect(handler).toBeDefined();
    const response = await handler!({}, { path: '/work/project-a' });
    expect(response.success).toBe(true);
    expect((response.data as { accepted: boolean }).accepted).toBe(true);

    expect(codememHint).toHaveBeenCalledWith('/work/project-a');
    expect(codebaseHint).toHaveBeenCalledWith('/work/project-a');
    expect(projectKnowledgeHint).toHaveBeenCalledWith('/work/project-a');
  });

  it('skips the local fan-out when nodeId is present (remote workspace)', async () => {
    const handler = handlers.get(IPC_CHANNELS.WORKSPACE_HINT_ACTIVE);
    const response = await handler!({}, { path: '/remote/project', nodeId: 'node-1' });
    expect(response.success).toBe(true);
    expect((response.data as { accepted: boolean }).accepted).toBe(false);

    expect(codememHint).not.toHaveBeenCalled();
    expect(codebaseHint).not.toHaveBeenCalled();
    expect(projectKnowledgeHint).not.toHaveBeenCalled();
  });

  it('rejects payloads with no path', async () => {
    const handler = handlers.get(IPC_CHANNELS.WORKSPACE_HINT_ACTIVE);
    const response = await handler!({}, {});
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('WORKSPACE_HINT_ACTIVE_FAILED');
  });

  it('keeps fanning out when one coordinator throws', async () => {
    codememHint.mockImplementation(() => {
      throw new Error('codemem boom');
    });

    const handler = handlers.get(IPC_CHANNELS.WORKSPACE_HINT_ACTIVE);
    const response = await handler!({}, { path: '/work/project-b' });
    expect(response.success).toBe(true);

    // codemem failed but the other two should still have been called.
    expect(codememHint).toHaveBeenCalledTimes(1);
    expect(codebaseHint).toHaveBeenCalledWith('/work/project-b');
    expect(projectKnowledgeHint).toHaveBeenCalledWith('/work/project-b');
  });
});
