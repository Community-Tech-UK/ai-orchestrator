import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore } from './browser-approval-store';

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('BrowserApprovalStore', () => {
  let db: SqliteDriver;
  let store: BrowserApprovalStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    db = createDb();
    store = new BrowserApprovalStore(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('creates and resolves approval requests', () => {
    const created = store.createRequest({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'profile-1',
      targetId: 'target-1',
      toolName: 'browser.click',
      action: 'click',
      actionClass: 'submit',
      origin: 'https://play.google.com',
      url: 'https://play.google.com/console',
      selector: 'button[type="submit"]',
      elementContext: {
        role: 'button',
        accessibleName: 'Submit for review',
      },
      proposedGrant: {
        mode: 'per_action',
        allowedOrigins: [
          {
            scheme: 'https',
            hostPattern: 'play.google.com',
            includeSubdomains: true,
          },
        ],
        allowedActionClasses: ['submit'],
        allowExternalNavigation: false,
        autonomous: false,
      },
      expiresAt: 61_000,
    });

    expect(created).toMatchObject({
      id: created.requestId,
      instanceId: 'instance-1',
      status: 'pending',
      createdAt: 1_000,
    });
    expect(store.getRequest(created.requestId, 'instance-1')).toEqual(created);
    expect(store.getRequest(created.requestId, 'other-instance')).toBeNull();

    vi.setSystemTime(2_000);
    const approved = store.resolveRequest(created.requestId, {
      status: 'approved',
      grantId: 'grant-1',
    });

    expect(approved?.status).toBe('approved');
    expect(approved?.grantId).toBe('grant-1');
    expect(approved?.decidedAt).toBe(2_000);
    expect(store.listRequests({ status: 'approved' })).toEqual([approved]);
  });

  it('keeps the agent’s stated reason apart from the page element it describes', () => {
    const input = {
      instanceId: 'instance-1',
      provider: 'claude' as const,
      profileId: 'existing-tab:n.windows-pc:1:2',
      targetId: 'existing-tab:n.windows-pc:1:2:target',
      toolName: 'browser.click',
      action: 'click',
      actionClass: 'submit' as const,
      origin: 'https://shop.example.com',
      elementContext: { role: 'button', accessibleName: 'Submit order' },
      proposedGrant: {
        mode: 'per_action' as const,
        allowedOrigins: [{ scheme: 'https' as const, hostPattern: 'shop.example.com', includeSubdomains: false }],
        allowedActionClasses: ['submit' as const],
        allowExternalNavigation: false,
        autonomous: false,
      },
      expiresAt: 61_000,
    };
    const withReason = store.createRequest({ ...input, requestReason: 'Placing the order you asked for' });
    const without = store.createRequest(input);

    const stored = store.getRequest(withReason.requestId)!;
    expect(stored.requestReason).toBe('Placing the order you asked for');
    expect(stored.elementContext).toEqual({ role: 'button', accessibleName: 'Submit order' });
    expect(JSON.stringify(stored.elementContext)).not.toContain('Placing the order');
    expect(store.listRequests({ status: 'pending' }).map((item) => item.requestReason).sort())
      .toEqual(['Placing the order you asked for', undefined]);
    expect('requestReason' in store.getRequest(without.requestId)!).toBe(false);
    expect(db.prepare('SELECT request_reason FROM browser_approval_requests WHERE request_id = ?')
      .get(withReason.requestId)).toEqual({ request_reason: 'Placing the order you asked for' });
  });

  it('never stores the computer: it is worked out when the list is read', () => {
    const created = store.createRequest({
      instanceId: 'instance-1',
      provider: 'claude',
      profileId: 'existing-tab:n.windows-pc:1:2',
      toolName: 'browser.click',
      action: 'click',
      actionClass: 'input',
      proposedGrant: {
        mode: 'per_action',
        allowedOrigins: [{ scheme: 'https', hostPattern: 'shop.example.com', includeSubdomains: false }],
        allowedActionClasses: ['input'],
        allowExternalNavigation: false,
        autonomous: false,
      },
      expiresAt: 61_000,
    });
    expect('computerId' in created).toBe(false);
    expect('computerId' in store.getRequest(created.requestId)!).toBe(false);
  });

  it('persists saved-login metadata and cannot overwrite a terminal credential decision', () => {
    const credentialAccess = {
      taskScope: 'conversation:placeholder', sessionName: 'Test session', reason: 'Sign in',
      origin: 'https://login.example.test', computerName: 'Test computer', computerId: 'test-node', scope: 'test-node',
      vaultItemRef: 'vault-placeholder', itemTitle: 'Saved test login', vaultFolder: 'AIO-Agent',
      moveIntoFolder: true, purposes: ['login'] as const, permission: 'task' as const,
    };
    const approval = store.createRequest({
      instanceId: 'instance-1', provider: 'codex', profileId: 'test-profile', targetId: 'test-target',
      toolName: 'browser.request_credential_access', action: 'request_credential_access', actionClass: 'credential',
      credentialAccess: { ...credentialAccess, purposes: [...credentialAccess.purposes] },
      proposedGrant: { mode: 'session', allowedOrigins: [{ scheme: 'https', hostPattern: 'login.example.test', includeSubdomains: false }],
        allowedActionClasses: ['credential'], allowExternalNavigation: false, autonomous: false }, expiresAt: 61_000,
    });
    expect(store.getRequest(approval.requestId)?.credentialAccess).toEqual(credentialAccess);
    store.resolveCredentialAccessRequest(approval.requestId, 'pending', { status: 'denied' });
    store.resolveCredentialAccessRequest(approval.requestId, 'pending', { status: 'approved', grantId: 'late-grant' });
    expect(store.getRequest(approval.requestId)).toMatchObject({ status: 'denied', grantId: undefined });
    expect(store.updateCredentialAccess(approval.requestId, { ...approval.credentialAccess!, operationError: 'late-error' })).toBeNull();
  });
});
