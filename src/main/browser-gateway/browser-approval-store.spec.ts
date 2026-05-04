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
});
