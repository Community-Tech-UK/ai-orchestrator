import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../validated-handler';
import type { Instance } from '../../../../shared/types/instance.types';
import type { PendingApprovalItem } from '../../../../shared/types/permission-registry.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { PermissionRegistry, getPermissionRegistry } from '../../../orchestration/permission-registry';
import { registerPermissionRegistryHandlers } from '../permission-registry-handlers';

const fakeEvent = {};

function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(fakeEvent, payload);
}

describe('registerPermissionRegistryHandlers', () => {
  const instances = new Map<string, Instance>();
  const instanceManager = {
    getInstance: (id: string) => instances.get(id),
  };

  beforeEach(() => {
    electronMocks.handlers.clear();
    vi.clearAllMocks();
    PermissionRegistry._resetForTesting();
    instances.clear();
    registerPermissionRegistryHandlers({ instanceManager });
  });

  it('lists a real pending PermissionRegistry request end-to-end (the reachability the defect lacked)', async () => {
    instances.set('inst-1', { id: 'inst-1', displayName: 'My Session', provider: 'claude' } as Instance);
    getPermissionRegistry().requestPermission({
      id: 'grant_1',
      instanceId: 'inst-1',
      action: 'desktop_computer_use_grant',
      description: 'Allow Computer Use observeAndInput for Calculator',
      toolName: 'computer.request_app_grant',
      details: { appId: 'com.apple.calculator', capability: 'observeAndInput' },
      createdAt: 1_000,
      timeoutMs: 60_000,
    });

    const result = await invoke('permission-registry:list-pending', {});
    expect(result.success).toBe(true);
    const items = result.data as PendingApprovalItem[];
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('grant_1');
    expect(items[0].expiresAt).toBe(61_000);
    expect(items[0].instanceLabel).toBe('My Session');
    expect(items[0].instanceProvider).toBe('claude');
  });

  it('excludes ACP-transport requests, which already have a working approval path', async () => {
    getPermissionRegistry().requestPermission({
      id: 'acp_1',
      instanceId: 'inst-1',
      action: 'edit',
      description: 'Edit File',
      details: { transport: 'acp' },
      createdAt: 1_000,
      timeoutMs: 60_000,
    });

    const result = await invoke('permission-registry:list-pending', {});
    expect(result.success).toBe(true);
    expect(result.data as PendingApprovalItem[]).toHaveLength(0);
  });

  it('filters by instanceId when provided', async () => {
    const registry = getPermissionRegistry();
    registry.requestPermission({ id: 'a', instanceId: 'i1', action: 'x', description: 'd', createdAt: 0, timeoutMs: 5000 });
    registry.requestPermission({ id: 'b', instanceId: 'i2', action: 'x', description: 'd', createdAt: 0, timeoutMs: 5000 });

    const result = await invoke('permission-registry:list-pending', { instanceId: 'i2' });
    expect((result.data as PendingApprovalItem[]).map((r) => r.id)).toEqual(['b']);
  });

  it('resolve(granted: true) approves the pending request and unblocks its awaited promise', async () => {
    const registry = getPermissionRegistry();
    const decisionPromise = registry.requestPermission({
      id: 'release_1', instanceId: 'inst-1', action: 'store_release_mutation',
      description: 'Allow App Store Connect release', createdAt: Date.now(), timeoutMs: 300_000,
    });

    const result = await invoke('permission-registry:resolve', { requestId: 'release_1', granted: true });
    expect(result.success).toBe(true);

    const decision = await decisionPromise;
    expect(decision.granted).toBe(true);
    expect(decision.decidedBy).toBe('user');
  });

  it('resolve(granted: false) denies the pending request', async () => {
    const registry = getPermissionRegistry();
    const decisionPromise = registry.requestPermission({
      id: 'calendar_1', instanceId: 'inst-1', action: 'calendar_mutation',
      description: 'Allow Microsoft calendar create_event', createdAt: Date.now(), timeoutMs: 300_000,
    });

    const result = await invoke('permission-registry:resolve', { requestId: 'calendar_1', granted: false });
    expect(result.success).toBe(true);

    const decision = await decisionPromise;
    expect(decision.granted).toBe(false);
    expect(decision.decidedBy).toBe('user');
  });

  it('resolve() on an unknown requestId returns a not-pending error instead of silently no-op-succeeding', async () => {
    const result = await invoke('permission-registry:resolve', { requestId: 'missing', granted: true });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PERMISSION_REGISTRY_NOT_PENDING');
  });

  it('extend() pushes the deadline out and returns the updated item', async () => {
    getPermissionRegistry().requestPermission({
      id: 'grant_2', instanceId: 'inst-1', action: 'desktop_computer_use_grant',
      description: 'Allow Computer Use observe for Calculator', createdAt: 1_000, timeoutMs: 60_000,
    });

    const result = await invoke('permission-registry:extend', { requestId: 'grant_2', extraMs: 120_000 });
    expect(result.success).toBe(true);
    const item = result.data as PendingApprovalItem;
    expect(item.timeoutMs).toBeGreaterThan(60_000);
  });

  it('rejects payloads that fail schema validation before touching the registry', async () => {
    const result = await invoke('permission-registry:resolve', { requestId: '', granted: true });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
  });
});
