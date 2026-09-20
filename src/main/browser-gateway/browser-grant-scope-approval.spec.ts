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
import { findMatchingBrowserGrant } from './browser-grant-policy';

const dbs: SqliteDriver[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe('persistent approval computer scope', () => {
  it.each([
    { managed: false, remote: true }, { managed: false, remote: false },
    { managed: true, remote: true }, { managed: true, remote: false },
  ])('ignores agent node overrides for managed=$managed remote=$remote, including old pending requests', async ({ managed, remote }) => {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    const approvalStore = new BrowserApprovalStore(db);
    const grantStore = new BrowserGrantStore(db);
    const origin = { scheme: 'https' as const, hostPattern: 'example.com', includeSubdomains: false };
    const nodeId = remote ? 'windows-pc' : 'local';
    const profileId = managed ? 'managed-profile' : remote ? 'existing-tab:n.windows-pc:tab-1' : 'existing-tab:tab-1';
    const profile: BrowserProfile = { id: profileId, label: 'Test profile', browser: 'chrome', mode: 'session',
      status: 'running', allowedOrigins: [origin], createdAt: 1, updatedAt: 1, executionNodeId: remote ? nodeId : undefined };
    const tab = { profileId, targetId: 'tab-1', nodeId: remote ? nodeId : undefined, tabId: 1, windowId: 1,
      url: 'https://example.com', origin: 'https://example.com', allowedOrigins: [origin], attachedAt: 1, updatedAt: 1 };
    const target: BrowserTarget = { id: tab.targetId, profileId, mode: 'session', driver: 'cdp', status: 'available',
      lastSeenAt: 1, url: tab.url, origin: tab.origin };
    const result = <T>(value: BrowserGatewayResultInput<T>): BrowserGatewayResult<T> => ({ ...value, auditId: 'audit' }) as BrowserGatewayResult<T>;
    const profileStore = { getProfile: () => managed ? profile : null, setRuntimeState: vi.fn() };
    const requests = new BrowserGrantRequestOperations({ approvalStore, grantStore, profileStore, result,
      extensionTabStore: { getTab: () => managed ? null : tab }, getLiveTarget: async () => ({ target }) });
    const payload = BrowserRequestGrantRequestSchema.parse({ profileId, targetId: tab.targetId, proposedGrant: {
      mode: 'session', nodeId: 'other-worker', allowedOrigins: [origin], allowedActionClasses: ['credential'],
      allowExternalNavigation: false, autonomous: false,
    } });
    const pending = await requests.requestGrant({ ...payload, instanceId: 'agent-1', provider: 'codex' });
    if (pending.decision !== 'requires_user') throw new Error('Expected approval request');
    const approval = approvalStore.getRequest(pending.requestId)!;
    expect(approval.proposedGrant.nodeId).toBe(nodeId);

    // Old pending rows predate proposal normalization. They still must not
    // transfer the operator's consent to the agent-supplied computer.
    db.prepare('UPDATE browser_approval_requests SET proposed_grant_json = ? WHERE request_id = ?')
      .run(JSON.stringify({ ...approval.proposedGrant, nodeId: 'other-worker' }), approval.requestId);
    const oldApproval = approvalStore.getRequest(approval.requestId)!;
    const operations = new BrowserGatewayApprovalOperations({ approvalStore, grantStore, profileStore, result });
    const approved = await operations.approveRequest({ requestId: approval.requestId,
      grant: { ...oldApproval.proposedGrant, mode: 'persistent', autonomous: true } });
    const grant = approved.data!;
    expect(grant.nodeId).toBe(nodeId);
    expect(grant.profileId).toBe(managed ? profileId : undefined);
    expect(grant.allowedOrigins).toEqual([origin]);
    const matching = (computer: string | undefined) => findMatchingBrowserGrant({ grants: [grant],
      instanceId: 'future-agent', provider: 'claude', nodeId: computer,
      profileId: managed ? profileId : `existing-tab:n.${computer ?? 'local'}:tab-2`,
      origin: tab.origin, actionClass: 'credential' }).grant;
    expect(matching(remote ? nodeId : undefined)?.id).toBe(grant.id);
    expect(matching('other-worker')).toBeUndefined();
  });
});
