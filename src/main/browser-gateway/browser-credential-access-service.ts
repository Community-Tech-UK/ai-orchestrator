import type { BrowserApprovalRequest, BrowserCredentialAccessChoice, BrowserCredentialAccessMetadata, BrowserGatewayResult, BrowserPermissionGrant, BrowserRequestCredentialAccess as BrowserRequestCredentialAccessPayload } from '@contracts/types/browser';
import { BrowserCredentialAccessChoiceSchema, BrowserRequestCredentialAccessSchema, BrowserProviderSchema, TASK_CREDENTIAL_ACCESS_MS } from '@contracts/schemas/browser';
import { generateId } from '../../shared/utils/id-generator';
import { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserGrantStore } from './browser-grant-store';
import type { CredentialAuthorizationService } from './browser-credential-authorization-store';
import { CredentialVaultError, type CredentialVault } from './browser-credential-vault';
import type { CredentialAccessSession } from './browser-credential-access-session';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import { createCredentialAccessDependencies } from './browser-credential-access-runtime';

export interface BrowserCredentialAccessDependencies {
  store: BrowserApprovalStore;
  authorizations: CredentialAuthorizationService;
  vault: Pick<CredentialVault, 'inspectExistingCredential' | 'enrolExistingCredential'>;
  grants: Pick<BrowserGrantStore, 'createGrant' | 'getGrant' | 'revokeGrant'>;
  resolveSession: (instanceId?: string) => CredentialAccessSession | undefined;
  findSession: (taskScope: string) => CredentialAccessSession | undefined;
  readTarget: (profileId: string, targetId: string, context?: BrowserGatewayContext) => Promise<{ origin: string; scope: string; computerName: string; computerId?: string }>;
  now: () => number;
  result: <T>(input: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  notify?: (request: BrowserApprovalRequest) => void | Promise<void>;
}

const PENDING_MS = 30 * 60_000;

/** The agent requests; only an operator decision calls approve. */
export class BrowserCredentialAccessService {
  private readonly requests = new Map<string, Promise<BrowserGatewayResult<BrowserApprovalRequest | null>>>();
  private readonly approvals = new Map<string, Promise<BrowserGatewayResult<BrowserPermissionGrant | null>>>();

  constructor(private readonly deps: BrowserCredentialAccessDependencies) {}

  request(input: BrowserRequestCredentialAccessPayload, context: BrowserGatewayContext): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    const key = JSON.stringify([context.instanceId, input.profileId, input.targetId, input.item, input.purposes]);
    const existing = this.requests.get(key);
    if (existing) return existing;
    const run = this.createRequest(input, context).finally(() => this.requests.delete(key));
    this.requests.set(key, run);
    return run;
  }

  private async createRequest(raw: BrowserRequestCredentialAccessPayload, context: BrowserGatewayContext): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    let approval: BrowserApprovalRequest | undefined;
    try {
      const input = BrowserRequestCredentialAccessSchema.parse(raw);
      const session = this.deps.resolveSession(context.instanceId);
      if (!session) return this.report(null, context, 'denied', 'session_unavailable');
      const target = await this.deps.readTarget(input.profileId, input.targetId, context);
      const inspected = await this.deps.vault.inspectExistingCredential({ item: input.item, origin: target.origin });
      const purposes = [...new Set(input.purposes ?? ['login'])].sort() as ('login' | 'totp')[];
      const metadata: BrowserCredentialAccessMetadata = {
        taskScope: session.taskScope, sessionName: session.sessionName, reason: input.reason,
        origin: target.origin, scope: target.scope, computerName: target.computerName, computerId: target.computerId ?? target.scope,
        vaultItemRef: inspected.vaultItemRef, itemTitle: inspected.title, vaultFolder: inspected.folderName,
        moveIntoFolder: inspected.requiresMoveIntoFolder, purposes, permission: 'task',
      };
      const existing = this.deps.store.findCredentialAccessRequest(metadata);
      if (existing) {
        const m = existing.credentialAccess;
        if (!m) throw new Error('credential_metadata_missing');
        const current = this.refresh(existing);
        if (current.status === 'pending') {
          approval = this.deps.store.updateCredentialAccess(current.requestId, { ...m, sessionName: session.sessionName }, { instanceId: session.instanceId, profileId: input.profileId, targetId: input.targetId }) ?? current;
          return this.report(approval, context, 'requires_user', 'awaiting_approval');
        }
        if (current.status === 'approved' && !inspected.requiresMoveIntoFolder && inspected.existingBinding?.origin === metadata.origin) return this.report(current, context, 'allowed', 'existing_permission');
        if (current.status === 'denied' && current.expiresAt > this.deps.now()) return this.report(current, context, 'denied', 'denied');
      }
      approval = this.deps.store.createRequest({
        instanceId: session.instanceId, provider: BrowserProviderSchema.parse(context.provider ?? 'orchestrator'), profileId: input.profileId, targetId: input.targetId,
        toolName: 'browser.request_credential_access', action: 'request_credential_access', actionClass: 'credential', origin: target.origin,
        credentialAccess: metadata, expiresAt: this.deps.now() + PENDING_MS,
        proposedGrant: { mode: 'session', nodeId: target.scope, allowedOrigins: [this.allowedOrigin(target.origin)], allowedActionClasses: ['credential'], allowExternalNavigation: false, autonomous: false },
      });
      // Standing consent can be reused, but never enrol or move an item implicitly.
      if (!inspected.requiresMoveIntoFolder && inspected.existingBinding?.origin === metadata.origin) {
        const decisions = purposes.map((purpose) => this.deps.authorizations.check({ profileId: target.scope, origin: target.origin, purpose, taskScope: session.taskScope, vaultItemRef: inspected.vaultItemRef, computerId: metadata.computerId }));
        const id = decisions[0]?.authorizationId;
        if (id && decisions.every((decision) => decision.authorized && decision.authorizationId === id)) {
          const auth = this.deps.authorizations.find(id)!;
          this.deps.store.updateCredentialAccess(approval.requestId, { ...metadata, authorizationId: id, permission: auth.taskScope ? 'task' : 'remember', permissionExpiresAt: auth.expiresAt });
          approval = this.deps.store.resolveCredentialAccessRequest(approval.requestId, 'pending', { status: 'approved' })!;
          return this.report(approval, context, 'allowed', 'existing_permission');
        }
      }
      return this.report(approval, context, 'requires_user', 'awaiting_approval');
    } catch (error) {
      return this.report(approval ?? null, context, 'denied', this.safeError(error));
    }
  }

  async status(requestId: string, context: BrowserGatewayContext): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    const request = this.owned(requestId, context);
    if (!request) return this.report(null, context, 'denied', 'request_not_owned');
    const current = this.refresh(request);
    return this.report(current, context, current.status === 'pending' ? 'requires_user' : current.status === 'approved' ? 'allowed' : 'denied', current.status);
  }

  async cancel(requestId: string, context: BrowserGatewayContext): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    const request = this.owned(requestId, context);
    if (!request) return this.report(null, context, 'denied', 'request_not_owned');
    return this.deny(request);
  }

  async deny(input: BrowserApprovalRequest): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    const request = this.deps.store.getRequest(input.requestId);
    if (!request?.credentialAccess) return this.report(null, {}, 'denied', 'credential_request_not_found');
    const current = this.refresh(request);
    if (current.status !== 'pending') return this.report(current, {}, 'denied', current.status);
    const denied = this.deps.store.resolveCredentialAccessRequest(current.requestId, 'pending', { status: 'denied' })!;
    this.notify(denied);
    return this.report(denied, {}, 'allowed', 'denied');
  }

  approve(input: BrowserApprovalRequest, choice: BrowserCredentialAccessChoice = { permission: 'task' }): Promise<BrowserGatewayResult<BrowserPermissionGrant | null>> {
    const running = this.approvals.get(input.requestId);
    if (running) return running;
    const run = this.applyApproval(input.requestId, choice).finally(() => this.approvals.delete(input.requestId));
    this.approvals.set(input.requestId, run);
    return run;
  }

  private async applyApproval(requestId: string, rawChoice: BrowserCredentialAccessChoice): Promise<BrowserGatewayResult<BrowserPermissionGrant | null>> {
    let request = this.deps.store.getRequest(requestId);
    if (!request?.credentialAccess) return this.reportGrant(null, request, 'denied', 'credential_request_not_found');
    request = this.refresh(request);
    if (request.status === 'approved') {
      const grant = request.grantId ? this.deps.grants.getGrant(request.grantId) : null;
      return this.reportGrant(grant, request, 'allowed', 'already_approved');
    }
    if (request.status !== 'pending') return this.reportGrant(null, request, 'denied', request.status);
    try {
      const choice = BrowserCredentialAccessChoiceSchema.parse(rawChoice);
      const session = this.deps.findSession(request.credentialAccess!.taskScope);
      if (!session) throw new Error('session_unavailable');
      const m = request.credentialAccess!;
      await this.validateTarget(request, m, session);
      const preview = await this.deps.vault.inspectExistingCredential({ item: m.vaultItemRef, origin: m.origin });
      if (preview.vaultItemRef !== m.vaultItemRef || preview.title !== m.itemTitle || preview.folderName !== m.vaultFolder || (preview.requiresMoveIntoFolder && !m.moveIntoFolder)) throw new Error('saved_login_changed');
      this.requirePending(requestId);
      const accepted: BrowserCredentialAccessMetadata = {
        ...m, permission: choice.permission, operationError: undefined,
        authorizationId: m.authorizationId ?? generateId(),
        permissionExpiresAt: Math.min(m.permissionExpiresAt ?? Number.MAX_SAFE_INTEGER, this.deps.now() + (choice.permission === 'remember' ? choice.rememberForMs : TASK_CREDENTIAL_ACCESS_MS)),
      };
      // Choice is durable before enrolment. Retrying cannot silently extend its lifetime.
      request = this.deps.store.updateCredentialAccess(requestId, accepted, { instanceId: session.instanceId, profileId: request.profileId, targetId: request.targetId! })!;
      if (!request) throw new Error('request_no_longer_pending');
      await this.deps.vault.enrolExistingCredential({ item: m.vaultItemRef, expectedVaultItemRef: m.vaultItemRef, origin: m.origin, moveIntoFolder: m.moveIntoFolder });
      this.requirePending(requestId);
      await this.validateTarget(request, accepted, session);
      this.requirePending(requestId);
      if (accepted.permissionExpiresAt! <= this.deps.now()) throw new Error('permission_expired');
      const savedRequest = request;
      let createdGrant: BrowserPermissionGrant | undefined;
      let createdAuthorizationId: string | undefined;
      let committed: { grant: BrowserPermissionGrant; approved: BrowserApprovalRequest };
      try {
        committed = this.deps.store.commitCredentialAccessDecision(() => {
          let auth = this.deps.authorizations.find(accepted.authorizationId!);
          if (auth && (auth.revokedAt || auth.expiresAt <= this.deps.now())) throw new Error('authorization_revoked');
          if (!auth) auth = this.deps.authorizations.create({
            profileId: m.scope, allowedOrigins: [{ scheme: new URL(m.origin).protocol.slice(0, -1) as 'http' | 'https', hostPattern: new URL(m.origin).host, includeSubdomains: false }], purposes: m.purposes, computerId: m.computerId,
            vaultFolder: m.vaultFolder, vaultItemRef: m.vaultItemRef,
            ...(choice.permission === 'task' ? { taskScope: m.taskScope } : {}), expiresAt: accepted.permissionExpiresAt!,
          }, accepted.authorizationId!);
          createdAuthorizationId = auth.id;
          const grant = this.deps.grants.createGrant({
            mode: 'session', instanceId: session.instanceId, provider: savedRequest.provider, profileId: savedRequest.profileId,
            targetId: savedRequest.targetId, nodeId: m.scope, allowedOrigins: [this.allowedOrigin(m.origin)], allowedActionClasses: ['credential'],
            // Saved-item consent belongs to the secure broker, never arbitrary password typing.
            allowExternalNavigation: false, autonomous: false, userApprovedCredentials: false,
            requestedBy: session.instanceId, decidedBy: 'user', decision: 'allow', expiresAt: auth.expiresAt, reason: 'saved_login_access_approved',
          });
          createdGrant = grant;
          const approved = this.deps.store.resolveCredentialAccessRequest(requestId, 'pending', { status: 'approved', grantId: grant.id });
          if (approved?.status !== 'approved') throw new Error('request_no_longer_pending');
          return { grant, approved };
        });
      } catch (error) {
        // Also compensate injected stores that do not share the SQLite transaction.
        if (createdAuthorizationId) this.deps.authorizations.revoke(createdAuthorizationId);
        if (createdGrant) this.deps.grants.revokeGrant(createdGrant.id);
        const expired = this.deps.store.resolveCredentialAccessRequest(requestId, 'pending', { status: 'expired' });
        if (expired) this.notify(expired);
        throw error;
      }
      this.notify(committed.approved);
      return this.reportGrant(committed.grant, committed.approved, 'allowed', 'approved');
    } catch (error) {
      const reason = this.safeError(error);
      const current = this.deps.store.getRequest(requestId);
      if (current?.status === 'pending' && current.credentialAccess) this.deps.store.updateCredentialAccess(requestId, { ...current.credentialAccess, operationError: reason });
      return this.reportGrant(null, current, 'denied', reason);
    }
  }

  private async validateTarget(request: BrowserApprovalRequest, m: BrowserCredentialAccessMetadata, session: CredentialAccessSession): Promise<void> {
    const target = await this.deps.readTarget(request.profileId, request.targetId!, { instanceId: session.instanceId, provider: request.provider });
    if (target.origin !== m.origin) throw new Error('origin_changed');
    if (target.scope !== m.scope) throw new Error('computer_changed');
    if ((target.computerId ?? target.scope) !== m.computerId) throw new Error('computer_changed');
    if (this.deps.findSession(m.taskScope)?.instanceId !== session.instanceId) throw new Error('session_changed');
  }

  private requirePending(requestId: string): void {
    const request = this.deps.store.getRequest(requestId);
    if (!request || this.refresh(request).status !== 'pending') throw new Error('request_no_longer_pending');
  }

  private owned(requestId: string, context: BrowserGatewayContext): BrowserApprovalRequest | null {
    const session = this.deps.resolveSession(context.instanceId);
    const request = this.deps.store.getRequest(requestId);
    return session && request?.credentialAccess?.taskScope === session.taskScope ? request : null;
  }

  private refresh(request: BrowserApprovalRequest): BrowserApprovalRequest {
    request = this.deps.store.getRequest(request.requestId) ?? request;
    const m = request.credentialAccess;
    if (!m) return request;
    const auth = m.authorizationId ? this.deps.authorizations.find(m.authorizationId) : undefined;
    const expired = request.status === 'pending' ? request.expiresAt <= this.deps.now() : request.status === 'approved' && (!auth || !!auth.revokedAt || auth.expiresAt <= this.deps.now());
    if (!expired) return request;
    const result = this.deps.store.resolveCredentialAccessRequest(request.requestId, request.status, { status: 'expired' })!;
    if (request.grantId) this.deps.grants.revokeGrant(request.grantId);
    this.notify(result);
    return result;
  }

  refreshRequest(request: BrowserApprovalRequest): BrowserApprovalRequest { return this.refresh(request); }

  revokeForGrant(grantId: string): void {
    const request = this.deps.store.findCredentialAccessByGrant(grantId);
    if (!request?.credentialAccess?.authorizationId) return;
    this.deps.authorizations.revoke(request.credentialAccess.authorizationId);
    this.refresh(request);
  }

  private notify(request: BrowserApprovalRequest): void {
    // Notifications are best effort; a persisted decision remains queryable after reconnect.
    void Promise.resolve().then(() => this.deps.notify?.(request)).catch(() => undefined);
  }

  private allowedOrigin(origin: string) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('origin_invalid');
    return { scheme: url.protocol.slice(0, -1) as 'http' | 'https', hostPattern: url.hostname.toLowerCase(), ...(url.port ? { port: Number(url.port) } : {}), includeSubdomains: false };
  }

  private safeError(error: unknown): string {
    if (error instanceof CredentialVaultError) return error.code;
    if (error instanceof Error && /^[a-z_]{1,100}$/.test(error.message)) return error.message;
    return 'credential_access_failed';
  }

  private report(data: BrowserApprovalRequest | null, context: BrowserGatewayContext, decision: BrowserGatewayResult<unknown>['decision'], reason: string): BrowserGatewayResult<BrowserApprovalRequest | null> {
    return this.deps.result({ context, data, decision, outcome: decision === 'allowed' ? 'succeeded' : 'not_run', reason,
      action: 'credential_access', toolName: 'browser.request_credential_access', actionClass: 'credential', summary: 'Saved login access status',
      requestId: data?.requestId, profileId: data?.profileId, targetId: data?.targetId, origin: data?.origin });
  }

  private reportGrant(data: BrowserPermissionGrant | null, request: BrowserApprovalRequest | null | undefined, decision: BrowserGatewayResult<unknown>['decision'], reason: string): BrowserGatewayResult<BrowserPermissionGrant | null> {
    return this.deps.result({ context: { instanceId: request?.instanceId, provider: request?.provider }, data, decision, outcome: decision === 'allowed' ? 'succeeded' : 'not_run', reason,
      action: 'credential_access', toolName: 'browser.request_credential_access', actionClass: 'credential', summary: 'Saved login access decision',
      requestId: request?.requestId, profileId: request?.profileId, targetId: request?.targetId, origin: request?.origin });
  }
}

let service: BrowserCredentialAccessService | undefined;
export function getBrowserCredentialAccessService(): BrowserCredentialAccessService {
  return service ??= new BrowserCredentialAccessService(createCredentialAccessDependencies());
}
export function resetBrowserCredentialAccessServiceForTesting(): void { service = undefined; }
