import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore, type BrowserApprovalRequestInput } from './browser-approval-store';

describe('browser approval cleanup after sidechat deletion', () => {
  let db: SqliteDriver;
  let store: BrowserApprovalStore;
  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new BrowserApprovalStore(db);
  });
  afterEach(() => db.close());

  function request(instanceId = 'side-runtime'): BrowserApprovalRequestInput {
    return {
      instanceId, provider: 'claude', profileId: 'profile-placeholder', toolName: 'browser.click', action: 'click',
      actionClass: 'submit', expiresAt: Date.now() + 60_000,
      proposedGrant: { mode: 'per_action', allowedOrigins: [], allowedActionClasses: ['submit'],
        allowExternalNavigation: false, autonomous: false },
    };
  }

  it('expires all pending requests beyond the UI page limit and preserves final decisions and other sessions', () => {
    const pending = Array.from({ length: 105 }, () => store.createRequest(request()));
    const decided = store.createRequest(request());
    store.resolveRequest(decided.requestId, { status: 'approved', grantId: 'grant-placeholder' });
    const other = store.createRequest(request('parent-runtime'));

    expect(store.expireForInstance('side-runtime')).toBe(105);

    for (const approval of pending) {
      expect(store.getRequest(approval.requestId)).toMatchObject({ status: 'expired', decidedAt: expect.any(Number) });
    }
    expect(store.getRequest(decided.requestId)).toMatchObject({ status: 'approved', grantId: 'grant-placeholder' });
    expect(store.getRequest(other.requestId)?.status).toBe('pending');
    expect(store.expireForInstance('side-runtime')).toBe(0);
  });

  it('expires saved-login and device-login requests without treating them as ordinary approval decisions', () => {
    const saved = store.createRequest({ ...request(), actionClass: 'credential',
      credentialAccess: {
        taskScope: 'conversation:placeholder', sessionName: 'Sidechat', reason: 'Sign in',
        origin: 'https://login.example.test', computerName: 'Test computer', computerId: 'node-placeholder', scope: 'node-placeholder',
        vaultItemRef: 'vault-placeholder', itemTitle: 'Saved test login', vaultFolder: 'AIO-Agent',
        moveIntoFolder: true, purposes: ['login'], permission: 'task',
      },
    });
    const expiresAt = Date.now() + 60_000;
    const device = store.createRequest({ ...request(), provider: 'codex', instanceId: 'session-placeholder',
      profileId: 'browser-profile', targetId: 'target-placeholder', actionClass: 'credential',
      toolName: 'browser.fill_device_login', action: 'fill_device_login',
      origin: 'https://auth.openai.com', expiresAt,
      proposedGrant: { mode: 'per_action', allowedOrigins: [{ scheme: 'https', hostPattern: 'auth.openai.com', includeSubdomains: false }],
        allowedActionClasses: ['credential'], allowExternalNavigation: false, autonomous: false },
      deviceLogin: {
        operationHandle: 'operation-placeholder', ownerSessionId: 'session-placeholder', ownerGeneration: 'generation-placeholder',
        nativeNodeId: 'native-node', nativeProfileId: 'native-profile', nativeComputerName: 'Test Mac',
        browserNodeId: 'browser-node', browserProfileId: 'browser-profile', browserComputerName: 'Test PC', targetId: 'target-placeholder',
        origin: 'https://auth.openai.com', expectedIdentity: 'account@example.test', extensionInstanceId: 'extension-placeholder',
        extensionGeneration: 'extension-generation', documentId: 'document-placeholder', expiresAt,
      },
    });

    store.expireForInstance('side-runtime');
    store.expireForInstance('session-placeholder');

    expect(store.getRequest(saved.requestId)?.status).toBe('expired');
    expect(store.findDeviceLoginRequest(device.deviceLogin!)?.status).toBe('expired');
  });
});
