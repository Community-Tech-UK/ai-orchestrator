import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../../instance/instance-manager';

const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => { handlers.set(channel, handler); } },
}));

import { IPC_CHANNELS } from '@contracts/channels';
import { registerRuntimeChangePreviewHandlers } from './runtime-change-preview-handlers';

const MIN = 60_000;

function instance() {
  return {
    id: 'i1', provider: 'codex', status: 'idle', currentModel: 'gpt-6-astra', reasoningEffort: 'high', yoloMode: false,
    lastActivity: Date.now() - MIN,
    contextUsage: { used: 230_000, total: 1_000_000, percentage: 23, occupancyReported: true },
    outputBuffer: [{ id: 'u', type: 'user', content: 'hi', timestamp: 1 }, { id: 'a', type: 'assistant', content: 'yo', timestamp: 2 }],
  };
}

describe('runtime change preview IPC', () => {
  let manager: InstanceManager;

  beforeEach(() => {
    handlers.clear();
    const live = instance();
    manager = {
      getInstance: vi.fn((id: string) => (id === 'i1' ? live : undefined)),
      getAdapter: vi.fn(() => ({ getRuntimeCapabilities: () => ({ supportsResume: true, supportsForkSession: false }) })),
    } as unknown as InstanceManager;
    registerRuntimeChangePreviewHandlers(manager);
  });

  const call = (payload: unknown) => handlers.get(IPC_CHANNELS.INSTANCE_RUNTIME_CHANGE_PREVIEW)!({}, payload);

  it('registers on its own channel', () => {
    expect(IPC_CHANNELS.INSTANCE_RUNTIME_CHANGE_PREVIEW).toBe('instance:runtime-change-preview');
    expect(handlers.has(IPC_CHANNELS.INSTANCE_RUNTIME_CHANGE_PREVIEW)).toBe(true);
  });

  it('answers with the sentence for a model change on a large session', async () => {
    const reply = await call({ instanceId: 'i1', model: 'gpt-6.1-sol' }) as { success: boolean; data: { note: { kind: string; large: boolean; text: string } } };
    expect(reply.success).toBe(true);
    expect(reply.data.note).toMatchObject({ kind: 'model', large: true });
    expect(reply.data.note.text).toContain('230K tokens at full price');
  });

  it('answers with no note when there is nothing to say, and for an unknown session', async () => {
    expect(await call({ instanceId: 'i1', model: 'gpt-6-astra', reasoningEffort: 'high' })).toEqual({ success: true, data: { note: null } });
    expect(await call({ instanceId: 'nope', model: 'x' })).toEqual({ success: true, data: { note: null } });
  });

  it('can be asked about an auto-approve flip and an account move', async () => {
    expect(await call({ instanceId: 'i1', model: 'gpt-6-astra', yoloMode: true })).toEqual({ success: true, data: { note: null } });
    const move = await call({ instanceId: 'i1', accountProfileId: 'other' }) as { data: { note: { kind: string } | null } };
    expect(move.data.note?.kind).toBe('account');
  });

  it('refuses a malformed request without throwing', async () => {
    const reply = await call({ model: 'x' }) as { success: boolean; error: { code: string } };
    expect(reply.success).toBe(false);
    expect(reply.error.code).toBe('RUNTIME_CHANGE_PREVIEW_FAILED');
  });
});
