import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcRenderer } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';
import { createPlanQueueDomain } from '../../../../preload/domains/plan-queue.preload';

const state = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload: unknown) => Promise<IpcResponse>>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, callback: (event: unknown, payload: unknown) => Promise<IpcResponse>) => state.handlers.set(channel, callback) } }));
vi.mock('../../../plan-queue/plan-queue-coordinator', () => ({ getPlanQueueCoordinator: () => new EventEmitter() }));
import { registerPlanQueueHandlers } from '../plan-queue-handlers';

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); state.handlers.clear(); });

describe('queue preview preload to main filesystem path', () => {
  it('previews the same repository root as start when the parent session works in a nested directory', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aio-queue-preview-')));
    fixtures.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'one_plan.md'), '# Plan\n');
    registerPlanQueueHandlers({ windowManager: { sendToRenderer: vi.fn() } as never });
    const api = createPlanQueueDomain({ invoke: (channel: string, payload: unknown) => {
      const callback = state.handlers.get(channel);
      if (!callback) throw new Error('Missing registered preview handler');
      return callback({}, payload);
    } } as unknown as IpcRenderer, IPC_CHANNELS);
    await expect(api.planQueuePreview({ workspaceCwd: join(root, 'src'), kind: 'plans' }))
      .resolves.toMatchObject({ success: true, data: { found: 1, hiddenCopies: 0, hiddenCountComplete: true } });
    await expect(api.planQueuePreview({ workspaceCwd: root, kind: 'plans', glob: 'docs/plans/one_plan.md' }))
      .resolves.toMatchObject({ success: true, data: { found: 1, hiddenCopies: null } });
  });
  it('returns a structured validation failure before discovery for malformed input', async () => {
    registerPlanQueueHandlers({ windowManager: { sendToRenderer: vi.fn() } as never });
    const response = await state.handlers.get(IPC_CHANNELS.PLAN_QUEUE_PREVIEW)!({}, { workspaceCwd: 0, kind: 'plans' });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('PLAN_QUEUE_PREVIEW_FAILED');
  });
});
