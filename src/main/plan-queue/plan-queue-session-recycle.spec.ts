import { describe, expect, it } from 'vitest';
import { recycleQueueCopilotSession } from './plan-queue-session-recycle';
import type { PlanQueueInstanceRecord } from './plan-queue-host';

describe('queue Copilot same-owner context recycling', () => {
  it.each([[900, 0], [901, 1]])('recycles only above 90%% and preserves the owning session and history: %s', async (tokens, restarts) => {
    const worker: PlanQueueInstanceRecord = { id: 'owner', provider: 'copilot', status: 'idle',
      historyThreadId: 'history', providerSessionId: 'old-cli-session', outputBuffer: [{ type: 'assistant', content: 'Earlier work' }],
      workingDirectory: '/synthetic/queue-folder', contextUsage: { copilotUsage: { compactions: 1, postCompactionTokens: tokens, tokenLimit: 1000 } } };
    const calls: string[] = [];
    const port = {
      getInstance: (id: string) => id === worker.id ? worker : undefined,
      restartFreshInstance: async (id: string) => { calls.push(id); worker.providerSessionId = 'fresh-cli-session'; return 'archived-history'; },
    };
    expect(await recycleQueueCopilotSession(port, worker, () => undefined)).toBe(restarts === 1);
    expect(calls).toHaveLength(restarts);
    expect(worker).toMatchObject({ id: 'owner', historyThreadId: 'history', workingDirectory: '/synthetic/queue-folder', outputBuffer: [{ content: 'Earlier work' }] });
    if (restarts) expect(worker.providerSessionId).toBe('fresh-cli-session');
  });
  it('propagates a failed fresh restart instead of changing the owning instance ID', async () => {
    const worker: PlanQueueInstanceRecord = { id: 'owner', provider: 'copilot', status: 'idle', outputBuffer: [],
      contextUsage: { copilotUsage: { compactions: 1, postCompactionTokens: 950, tokenLimit: 1000 } } };
    await expect(recycleQueueCopilotSession({ getInstance: () => worker,
      restartFreshInstance: async () => { throw new Error('restart failed'); } }, worker, () => undefined)).rejects.toThrow('restart failed');
    expect(worker.id).toBe('owner');
  });
});
