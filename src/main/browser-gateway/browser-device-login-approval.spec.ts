import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore } from './browser-approval-store';
import { BrowserGatewayApprovalOperations } from './browser-gateway-approval-operations';
import type { BrowserApprovalRequestInput } from './browser-approval-store';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayResult } from '@contracts/types/browser';

const metadata = () => ({
  operationHandle: 'operation-placeholder', ownerSessionId: 'session-placeholder', ownerGeneration: 'generation-placeholder',
  nativeNodeId: 'native-node', nativeProfileId: 'native-profile', nativeComputerName: 'Test Mac',
  browserNodeId: 'browser-node', browserProfileId: 'browser-profile', browserComputerName: 'Test PC', targetId: 'target-placeholder',
  origin: 'https://auth.openai.com' as const, expectedIdentity: 'account@example.test',
  extensionInstanceId: 'extension-placeholder', extensionGeneration: 'extension-generation', documentId: 'document-placeholder', expiresAt: 61_000,
});
function input(): BrowserApprovalRequestInput {
  return {
    instanceId: 'session-placeholder', provider: 'codex', profileId: 'browser-profile', targetId: 'target-placeholder',
    toolName: 'browser.fill_device_login', action: 'fill_device_login', actionClass: 'credential', origin: 'https://auth.openai.com',
    deviceLogin: metadata(), proposedGrant: { mode: 'per_action', allowedOrigins: [{ scheme: 'https', hostPattern: 'auth.openai.com', includeSubdomains: false }],
      allowedActionClasses: ['credential'], allowExternalNavigation: false, autonomous: false }, expiresAt: 61_000,
  };
}

describe('operation-bound device-login approval', () => {
  let db: SqliteDriver;
  let store: BrowserApprovalStore;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new BrowserApprovalStore(db);
  });
  afterEach(() => { db.close(); vi.useRealTimers(); });

  it('persists distinct non-vault metadata and round-trips it after store recreation', () => {
    const created = store.createRequest(input());
    expect(new BrowserApprovalStore(db).getRequest(created.requestId)?.deviceLogin).toEqual(metadata());
    expect(created.credentialAccess).toBeUndefined();
  });
  it('requires exact owner and every operation binding, independent of list pagination', () => {
    const created = store.createRequest(input());
    const { deviceLogin: _device, ...ordinary } = input();
    for (let i = 0; i < 101; i++) store.createRequest({ ...ordinary, toolName: 'browser.click', action: 'click', actionClass: 'input' });
    expect(store.findDeviceLoginRequest(metadata())?.requestId).toBe(created.requestId);
    for (const key of Object.keys(metadata()) as (keyof ReturnType<typeof metadata>)[]) {
      if (key.endsWith('Name')) continue;
      const changed = { ...metadata(), [key]: key === 'expiresAt' ? 60_000 : 'changed-placeholder' };
      expect(() => store.findDeviceLoginRequest(changed as ReturnType<typeof metadata>)).not.toThrow();
      expect(store.findDeviceLoginRequest(changed as ReturnType<typeof metadata>)).toBeNull();
    }
  });
  it('refuses mismatched envelope bindings and credential mixing on creation', () => {
    expect(() => store.createRequest({ ...input(), instanceId: 'other-session' })).toThrow();
    expect(() => store.createRequest({ ...input(), profileId: 'other-profile' })).toThrow();
    expect(() => store.createRequest({ ...input(), expiresAt: 62_000 })).toThrow();
    expect(() => store.createRequest({ ...input(), deviceLogin: { ...metadata(), permission: 'remember' } } as BrowserApprovalRequestInput)).toThrow();
  });
  it('rejects ordinary resolution and atomically decides pending exact metadata only once', () => {
    const created = store.createRequest(input());
    store.resolveRequest(created.requestId, { status: 'approved', grantId: 'ordinary-grant' });
    expect(store.getRequest(created.requestId)?.status).toBe('pending');
    expect(store.resolveDeviceLoginRequest(created.requestId, { ...metadata(), documentId: 'changed' }, 'approved')).toBeNull();
    expect(store.resolveDeviceLoginRequest(created.requestId, metadata(), 'denied')?.status).toBe('denied');
    expect(store.resolveDeviceLoginRequest(created.requestId, metadata(), 'approved')).toBeNull();
    expect(store.getRequest(created.requestId)?.grantId).toBeUndefined();
  });
  it('expires at the exact native deadline and cancellation invalidates approved consent', () => {
    const created = store.createRequest(input());
    vi.setSystemTime(61_000);
    expect(store.resolveDeviceLoginRequest(created.requestId, metadata(), 'approved')).toBeNull();
    expect(store.getRequest(created.requestId)?.status).toBe('expired');
    vi.setSystemTime(1_000);
    const second = store.createRequest({ ...input(), deviceLogin: { ...metadata(), operationHandle: 'second-placeholder' } });
    store.resolveDeviceLoginRequest(second.requestId, second.deviceLogin!, 'approved');
    store.invalidateDeviceLoginRequests('second-placeholder', { sessionId: 'other', generation: metadata().ownerGeneration });
    expect(store.getRequest(second.requestId)?.status).toBe('approved');
    store.invalidateDeviceLoginRequests('second-placeholder', { sessionId: metadata().ownerSessionId, generation: metadata().ownerGeneration });
    expect(store.getRequest(second.requestId)?.status).toBe('expired');
    expect(store.resolveDeviceLoginRequest(second.requestId, second.deviceLogin!, 'approved')).toBeNull();
    expect(() => store.createRequest({ ...input(), deviceLogin: second.deviceLogin })).toThrow();
  });
  function operations() {
    const createGrant = vi.fn(); const autoApproveApproval = vi.fn();
    const ops = new BrowserGatewayApprovalOperations({ approvalStore: store,
      grantStore: { createGrant, listGrants: vi.fn(() => []), revokeGrant: vi.fn() },
      profileStore: { getProfile: vi.fn(() => null), setRuntimeState: vi.fn() }, autoApproveApproval,
      result: <T>(value: BrowserGatewayResultInput<T>) => ({ decision: value.decision, outcome: value.outcome, data: value.data, reason: value.reason, auditId: 'audit-placeholder' }) as BrowserGatewayResult<T>,
    });
    return { ops, createGrant, autoApproveApproval };
  }
  it('never auto-approves or mints a reusable grant, and requires explicit device choice', async () => {
    const created = store.createRequest(input()); const { ops, createGrant, autoApproveApproval } = operations();
    await ops.getApprovalStatus({ requestId: created.requestId, instanceId: created.instanceId });
    await ops.listApprovalRequests({ status: 'pending' });
    expect(autoApproveApproval).not.toHaveBeenCalled();
    expect(await ops.approveRequest({ requestId: created.requestId, grant: created.proposedGrant })).toMatchObject({ decision: 'denied' });
    expect(await ops.approveRequest({ requestId: created.requestId, grant: { ...created.proposedGrant, mode: 'session' }, deviceLogin: { permission: 'operation' } })).toMatchObject({ decision: 'denied' });
    expect(await ops.approveRequest({ requestId: created.requestId, grant: created.proposedGrant, deviceLogin: { permission: 'operation' } })).toMatchObject({ decision: 'allowed', data: null });
    expect(store.getRequest(created.requestId)?.status).toBe('approved');
    expect(createGrant).not.toHaveBeenCalled();
    expect(await ops.denyRequest({ requestId: created.requestId })).toMatchObject({ decision: 'denied' });
  });
});
