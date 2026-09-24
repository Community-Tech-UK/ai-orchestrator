import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserGatewayResult, BrowserProfile, BrowserTarget } from '@contracts/types/browser';
import { BrowserRequestGrantRequestSchema } from '@contracts/schemas/browser';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore } from './browser-approval-store';
import { BrowserGrantStore } from './browser-grant-store';
import { BrowserGrantRequestOperations } from './browser-grant-request-operations';
import { BrowserGatewayApprovalOperations } from './browser-gateway-approval-operations';
import type { BrowserGatewayResultInput } from './browser-gateway-result';

const dbs: SqliteDriver[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

// LT-620 (the request_grant sibling of LT-611): an approval raised without an
// instanceId is stored under 'unknown', so the covering-grant lookup must use
// the same sentinel or the caller can never see the grant it was just given.
describe('browser.request_grant without an instanceId', () => {
  it.each([{ managed: true }, { managed: false }])(
    'recognises the grant it just obtained (managed=$managed)',
    async ({ managed }) => {
      const db = defaultDriverFactory(':memory:');
      dbs.push(db);
      createTables(db);
      createMigrationsTable(db);
      runMigrations(db);
      const approvalStore = new BrowserApprovalStore(db);
      const grantStore = new BrowserGrantStore(db);
      const origin = { scheme: 'https' as const, hostPattern: 'example.com', includeSubdomains: false };
      const profileId = managed ? 'managed-profile' : 'existing-tab:tab-1';
      const profile: BrowserProfile = { id: profileId, label: 'Test profile', browser: 'chrome', mode: 'session',
        status: 'running', allowedOrigins: [origin], createdAt: 1, updatedAt: 1 };
      const tab = { profileId, targetId: 'tab-1', tabId: 1, windowId: 1, url: 'https://example.com',
        origin: 'https://example.com', allowedOrigins: [origin], attachedAt: 1, updatedAt: 1 };
      const target: BrowserTarget = { id: tab.targetId, profileId, mode: 'session', driver: 'cdp',
        status: 'available', lastSeenAt: 1, url: tab.url, origin: tab.origin };
      const result = <T>(value: BrowserGatewayResultInput<T>): BrowserGatewayResult<T> =>
        ({ ...value, auditId: 'audit' }) as BrowserGatewayResult<T>;
      const profileStore = { getProfile: () => managed ? profile : null, setRuntimeState: vi.fn() };
      const requests = new BrowserGrantRequestOperations({ approvalStore, grantStore, profileStore, result,
        extensionTabStore: { getTab: () => managed ? null : tab }, getLiveTarget: async () => ({ target }) });
      const payload = BrowserRequestGrantRequestSchema.parse({ profileId, targetId: tab.targetId, proposedGrant: {
        mode: 'session', allowedOrigins: [origin], allowedActionClasses: ['input'],
        allowExternalNavigation: false, autonomous: false,
      } });

      const pending = await requests.requestGrant({ ...payload, provider: 'codex' });
      if (pending.decision !== 'requires_user') throw new Error('Expected approval request');
      const approvals = new BrowserGatewayApprovalOperations({ approvalStore, grantStore, profileStore, result });
      const approval = approvalStore.getRequest(pending.requestId)!;
      await approvals.approveRequest({ requestId: approval.requestId, grant: approval.proposedGrant });

      const repeat = await requests.requestGrant({ ...payload, provider: 'codex' });
      expect(repeat.decision).toBe('allowed');
    },
  );
});
