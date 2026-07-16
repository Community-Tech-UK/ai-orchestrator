import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { DocReviewSession } from '@contracts/schemas/doc-review';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, IpcHandler>();

const openPath = vi.fn(async (_path: string) => '');

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
  },
  shell: { openPath: (p: string) => openPath(p) },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

class FakeService extends EventEmitter {
  listSessions = vi.fn((): DocReviewSession[] => [session]);
  getSession = vi.fn((id: string) => (id === session.id ? session : undefined));
  readArtifact = vi.fn(async () => '<html>artifact</html>');
  submitDecision = vi.fn(async () => ({ ...session, status: 'approved' as const }));
  retryDelivery = vi.fn(async () => ({ ...session, status: 'approved' as const }));
  dismiss = vi.fn();
  resolveArtifactFile = vi.fn(() => '/ws/.aio-review/plan.html');
}
let fake: FakeService;

vi.mock('../../doc-review/doc-review-service', () => ({
  DOC_REVIEW_CHANGED_EVENT: 'doc-review:changed',
  getDocReviewService: () => fake,
}));

const session: DocReviewSession = {
  id: 'dr_1',
  instanceId: 'inst-1',
  workspacePath: '/ws',
  title: 'Plan',
  artifactPath: '/ws/.aio-review/plan.html',
  status: 'pending',
  decisions: [],
  createdAt: 1,
  deliveryAttempts: [],
};

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({}, payload);
}

describe('registerDocReviewHandlers', () => {
  let sendToRenderer: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    handlers.clear();
    vi.clearAllMocks();
    fake = new FakeService();
    sendToRenderer = vi.fn();
    const { registerDocReviewHandlers } = await import('./doc-review-handlers');
    registerDocReviewHandlers({
      windowManager: { sendToRenderer } as never,
    });
  });

  it('lists sessions', async () => {
    const res = await invoke(IPC_CHANNELS.DOC_REVIEW_LIST, {});
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
  });

  it('reads the artifact html', async () => {
    const res = await invoke(IPC_CHANNELS.DOC_REVIEW_READ_ARTIFACT, { reviewId: 'dr_1' });
    expect(res.success).toBe(true);
    expect((res.data as { html: string }).html).toContain('artifact');
  });

  it('submits a decision through the service', async () => {
    const res = await invoke(IPC_CHANNELS.DOC_REVIEW_SUBMIT_DECISION, {
      reviewId: 'dr_1',
      overall: 'approved',
      decisions: [{ itemId: 'a', decision: 'approve' }],
    });
    expect(res.success).toBe(true);
    expect(fake.submitDecision).toHaveBeenCalledWith('dr_1', {
      overall: 'approved',
      decisions: [{ itemId: 'a', decision: 'approve' }],
      generalComment: undefined,
    });
  });

  it('rejects an invalid submit payload', async () => {
    const res = await invoke(IPC_CHANNELS.DOC_REVIEW_SUBMIT_DECISION, {
      reviewId: 'dr_1',
      overall: 'maybe',
      decisions: [],
    });
    expect(res.success).toBe(false);
    expect(fake.submitDecision).not.toHaveBeenCalled();
  });

  it('retries delivery for an already decided review', async () => {
    const res = await invoke(IPC_CHANNELS.DOC_REVIEW_RETRY_DELIVERY, { reviewId: 'dr_1' });
    expect(res.success).toBe(true);
    expect(fake.retryDelivery).toHaveBeenCalledWith('dr_1');
  });

  it('opens the validated artifact externally', async () => {
    const res = await invoke(IPC_CHANNELS.DOC_REVIEW_OPEN_EXTERNAL, { reviewId: 'dr_1' });
    expect(res.success).toBe(true);
    expect(openPath).toHaveBeenCalledWith('/ws/.aio-review/plan.html');
  });

  it('forwards change events to the renderer', () => {
    const event = { kind: 'created', reviewId: 'dr_1', session };
    fake.emit('doc-review:changed', event);
    expect(sendToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.DOC_REVIEW_CHANGED, event);
  });
});
