import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const access = vi.hoisted(() => ({ request: vi.fn(), status: vi.fn(), cancel: vi.fn() }));
const legacy = vi.hoisted(() => ({ enrol: vi.fn(), authorize: vi.fn(), list: vi.fn(), revoke: vi.fn() }));
vi.mock('../browser-gateway/browser-credential-access-service', () => ({
  getBrowserCredentialAccessService: () => access,
}));
vi.mock('../browser-gateway/default-browser-credentials-operations', () => ({
  createDefaultBrowserCredentialsOperations: () => legacy,
}));
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../db/better-sqlite3-driver', () => ({ defaultDriverFactory: vi.fn(() => { throw new Error('Unexpected database access'); }) }));
vi.mock('../operator/operator-schema', () => ({ createOperatorTables: vi.fn() }));
vi.mock('../operator/operator-database', () => ({ defaultOperatorDbPath: () => '/tmp/never-opened.db' }));

import { dispatchBrowserCredentialsCliRpc } from './orchestrator-tools-rpc-browser-credentials';
import { OrchestratorToolsRpcServer } from './orchestrator-tools-rpc-server';
import { OrchestratorToolsRpcClient } from './orchestrator-tools-rpc-client';
import { BROWSER_CREDENTIALS_CLI_METHODS as methods } from './browser-credentials-cli-contracts';

const input = { profileId: 'profile-1', targetId: 'target-1', item: 'Portal test login', reason: 'Sign in for this task' };
const context = { instanceId: 'instance-1', provider: 'codex' };
function decision(status: 'pending' | 'approved' | 'denied' | 'expired' = 'pending') {
  return {
    decision: status === 'pending' ? 'requires_user' : 'allowed',
    outcome: status === 'pending' ? 'not_run' : 'succeeded', auditId: 'audit-1', requestId: 'request-1',
    data: {
      id: 'request-1', requestId: 'request-1', instanceId: context.instanceId,
      provider: context.provider, profileId: input.profileId, targetId: input.targetId,
      toolName: 'browser.request_credential_access', action: 'credential_access', actionClass: 'credential',
      origin: 'https://portal.example.com', status, createdAt: 1, expiresAt: 2,
      proposedGrant: {
        mode: 'session', allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.com', includeSubdomains: false }],
        allowedActionClasses: ['credential'], allowExternalNavigation: false, autonomous: false,
      },
      credentialAccess: {
        taskScope: 'task-1', sessionName: 'Test session', reason: input.reason,
        origin: 'https://portal.example.com', computerName: 'windows-pc', computerId: 'node-1', scope: 'node-1',
        vaultItemRef: 'item-1', itemTitle: input.item, vaultFolder: 'AIO-Agent',
        moveIntoFolder: false, purposes: ['login'], permission: 'task',
        ...(status === 'approved' ? { authorizationId: 'authorization-1' } : {}),
      },
    },
  };
}

describe('credential access CLI shared-service dispatch', () => {
  beforeEach(() => { vi.clearAllMocks(); access.request.mockResolvedValue(decision()); });

  it('uses the same service and trusted session context for requests', async () => {
    await expect(dispatchBrowserCredentialsCliRpc(methods.request, input, undefined, context)).resolves.toEqual(decision());
    expect(access.request).toHaveBeenCalledExactlyOnceWith(input, context);
  });

  it.each(['pending', 'approved', 'denied', 'expired'] as const)('returns the actual %s decision from the shared service', async (status) => {
    access.status.mockResolvedValue(decision(status));
    await expect(dispatchBrowserCredentialsCliRpc(methods.status, { requestId: 'request-1' }, undefined, context)).resolves.toEqual(decision(status));
    expect(access.status).toHaveBeenCalledExactlyOnceWith('request-1', context);
  });

  it('cancels the originating request through the shared service', async () => {
    access.cancel.mockResolvedValue(decision('denied'));
    await dispatchBrowserCredentialsCliRpc(methods.cancel, { requestId: 'request-1' }, undefined, context);
    expect(access.cancel).toHaveBeenCalledExactlyOnceWith('request-1', context);
  });

  it('rejects missing trusted context and caller-supplied session identity', async () => {
    await expect(dispatchBrowserCredentialsCliRpc(methods.request, input)).rejects.toThrow(/authenticated requesting session/);
    await expect(dispatchBrowserCredentialsCliRpc(methods.request, { ...input, instanceId: 'other-session' }, undefined, context)).rejects.toThrow();
    expect(access.request).not.toHaveBeenCalled();
  });

  it.each([methods.enrol, methods.authorize])('requires operator approval for authenticated legacy mutation %s', async (method) => {
    legacy.enrol.mockResolvedValue({ vaultItemRef: 'item-1', username: 'PLACEHOLDER_USER', movedIntoFolder: false, origin: 'https://portal.example.com' });
    legacy.authorize.mockResolvedValue({ id: 'auth-1', profileId: 'node-1', allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.com', includeSubdomains: false }], purposes: ['login'], vaultFolder: 'AIO-Agent', createdAt: 1, expiresAt: 2 });
    const payload = method === methods.enrol ? { item: input.item, origin: 'https://portal.example.com' }
      : { profileId: 'node-1', allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.com', includeSubdomains: false }], purposes: ['login'], vaultFolder: 'AIO-Agent', expiresAt: Date.now() + 10000 };
    await expect(dispatchBrowserCredentialsCliRpc(method, payload, legacy, context)).rejects.toThrow(/operator_credential_approval_required/);
    expect(legacy.enrol).not.toHaveBeenCalled();
    expect(legacy.authorize).not.toHaveBeenCalled();
  });

  it('keeps inspection and revocation available to authenticated sessions', async () => {
    legacy.list.mockResolvedValue([]);
    legacy.revoke.mockResolvedValue({ revoked: true });
    await expect(dispatchBrowserCredentialsCliRpc(methods.list, {}, legacy, context)).resolves.toEqual([]);
    await expect(dispatchBrowserCredentialsCliRpc(methods.revoke, { authorizationId: 'auth-1' }, legacy, context)).resolves.toEqual({ revoked: true });
    expect(legacy.list).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(legacy.revoke).toHaveBeenCalledExactlyOnceWith('auth-1');
  });

  it('does not report manual handoff or credential-free approval as authorization', async () => {
    const response = decision('approved');
    for (const credentialAccess of [undefined, { ...response.data.credentialAccess, authorizationId: undefined }]) {
      access.status.mockResolvedValue({ ...response, data: { ...response.data, credentialAccess } });
      await expect(dispatchBrowserCredentialsCliRpc(methods.status, { requestId: 'request-1' }, undefined, context)).rejects.toThrow();
    }
  });
});

describe('credential access authenticated CLI socket', () => {
  let directory: string;
  let server: OrchestratorToolsRpcServer;
  beforeEach(async () => {
    vi.clearAllMocks();
    access.request.mockResolvedValue(decision());
    directory = mkdtempSync(join(tmpdir(), 'credential-rpc-'));
    server = new OrchestratorToolsRpcServer({
      userDataPath: directory, isKnownLocalInstance: (id) => id === context.instanceId,
      toolFactory: () => [], registerCleanup: () => undefined,
    });
    await server.start();
  });
  afterEach(async () => { await server.stop(); rmSync(directory, { recursive: true, force: true }); });

  function client(capability?: string, instanceId = context.instanceId) {
    return new OrchestratorToolsRpcClient({ env: {
      AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: server.getSocketPath()!,
      AI_ORCHESTRATOR_INSTANCE_ID: instanceId,
      AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY: capability,
    }, timeoutMs: 3000 });
  }

  it('binds the request to the capability-authenticated originating session', async () => {
    const caller = client(server.getInstanceCapability(context.instanceId)!);
    await expect(caller.call(methods.request, input)).resolves.toEqual(decision());
    expect(access.request).toHaveBeenCalledExactlyOnceWith(input, { instanceId: context.instanceId });
  });

  it('rejects invalid capabilities and caller identity spoofing before any operation', async () => {
    await expect(client('PLACEHOLDER_INVALID_CAPABILITY').call(methods.request, input)).rejects.toThrow(/invalid or missing/);
    await expect(client(server.getInstanceCapability(context.instanceId)!, 'other-session').call(methods.request, input)).rejects.toThrow();
    await expect(client(server.getInstanceCapability(context.instanceId)!).call(methods.request, { ...input, instanceId: 'other-session' })).rejects.toThrow();
    expect(access.request).not.toHaveBeenCalled();
  });

  it.each([methods.enrol, methods.authorize])('refuses real socket legacy mutation %s before enrolment or authorization', async (method) => {
    legacy.enrol.mockResolvedValue({ vaultItemRef: 'item-1', username: 'PLACEHOLDER_USER', movedIntoFolder: false, origin: 'https://portal.example.com' });
    legacy.authorize.mockResolvedValue({ id: 'auth-1', profileId: 'node-1', allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.com', includeSubdomains: false }], purposes: ['login'], vaultFolder: 'AIO-Agent', createdAt: 1, expiresAt: 2 });
    const payload = method === methods.enrol ? { item: input.item, origin: 'https://portal.example.com' }
      : { profileId: 'node-1', allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.com', includeSubdomains: false }], purposes: ['login'], vaultFolder: 'AIO-Agent', expiresAt: Date.now() + 10000 };
    await expect(client(server.getInstanceCapability(context.instanceId)!).call(method, payload)).rejects.toThrow(/operator_credential_approval_required/);
    expect(legacy.enrol).not.toHaveBeenCalled();
    expect(legacy.authorize).not.toHaveBeenCalled();
  });
});
