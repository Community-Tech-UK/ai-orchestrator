import { isDeepStrictEqual } from 'node:util';
import type { BrowserDeviceLoginMetadata } from '@contracts/types/browser';
import { BrowserDeviceLoginMetadataSchema } from '@contracts/schemas/browser';
import { CodexDeviceLoginOwnerSchema, CodexDeviceLoginStartParamsSchema, CodexDeviceLoginViewSchema,
  type CodexDeviceLoginOwner, type CodexDeviceLoginView } from '../remote-node/codex-device-login-rpc';
import { COORDINATOR_TO_NODE } from '../remote-node/worker-node-rpc';
import type { CodexDeviceTransferRegistry } from '../remote-node/codex-device-transfer';
import type { BrowserApprovalStore } from './browser-approval-store';
import { createBrowserDeviceLoginDriver, type BrowserDeviceLoginDestination, type BrowserDeviceLoginDriverDependencies } from './browser-device-login-driver';
import { hasSynchronousAuthority } from './browser-extension-command-delivery';

export interface BrowserDeviceLoginOwnerSnapshot { object: object; restartEpoch: number; adapterGeneration: number }
export interface BrowserDeviceLoginNative { nodeId: string; profileId: string; computerName: string; expectedIdentity: string }
export interface BrowserDeviceLoginTarget extends Omit<BrowserDeviceLoginDestination, 'expectedIdentity' | 'expiresAt'> {
  computerName: string;
  /** Resolver applies normal target authority, including shared-tab opt-in. */
  isCurrent(): boolean;
}
export interface BrowserDeviceLoginOperationDependencies extends Pick<BrowserDeviceLoginDriverDependencies,
  'commands' | 'contacts' | 'ledger' | 'captureConfidentialConnection' | 'protectionEnabled'> {
  /** Owner generation has already been authenticated by the caller's trusted transport. */
  resolveOwner(owner: CodexDeviceLoginOwner): BrowserDeviceLoginOwnerSnapshot | null;
  resolveNative(input: { nodeId: string; profileId: string }, owner: CodexDeviceLoginOwner): BrowserDeviceLoginNative | null;
  resolveTarget(input: { profileId: string; targetId: string }, owner: CodexDeviceLoginOwner): Promise<BrowserDeviceLoginTarget>;
  /** Production wrapper sends service-scoped private worker RPC, never instance-scoped RPC. */
  worker: { request(nodeId: string, method: string, params: unknown): Promise<unknown> };
  approvals: Pick<BrowserApprovalStore, 'createRequest' | 'findDeviceLoginRequest' | 'invalidateDeviceLoginRequests'>;
  transfers: Pick<CodexDeviceTransferRegistry, 'register'>;
}
export type BrowserDeviceLoginFillResult = { status: 'requires_approval'; requestId: string; operation: CodexDeviceLoginView }
  | { status: 'submitted'; operation: CodexDeviceLoginView };
type Driver = ReturnType<typeof createBrowserDeviceLoginDriver>;
interface Operation {
  owner: CodexDeviceLoginOwner;
  snapshot: BrowserDeviceLoginOwnerSnapshot;
  native: BrowserDeviceLoginNative;
  lease: () => boolean;
  abort: AbortController;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  view?: CodexDeviceLoginView;
  target?: BrowserDeviceLoginTarget;
  browserLease?: () => boolean;
  driver?: Driver;
  metadata?: BrowserDeviceLoginMetadata;
  approvalId?: string;
  transferCancel?: () => void;
  busy: boolean;
  submitted: boolean;
}
const refused = () => new Error('device_login_request_refused');
const terminal = new Set(['authenticated', 'failed', 'cancelled', 'expired']);

/** Private composition. Public methods carry opaque operation views only, never codes. */
export class BrowserDeviceLoginOperationController {
  private readonly operations = new Set<Operation>();
  private closed = false;
  constructor(private readonly deps: BrowserDeviceLoginOperationDependencies) {}

  async start(input: { nodeId: string; profileId: string }, authenticatedOwner: CodexDeviceLoginOwner): Promise<CodexDeviceLoginView> {
    let op: Operation | undefined;
    try {
      const owner = CodexDeviceLoginOwnerSchema.parse(authenticatedOwner);
      CodexDeviceLoginStartParamsSchema.parse({ profileId: input.profileId, owner });
      const snapshot = this.deps.resolveOwner(owner);
      const native = this.deps.resolveNative(input, owner);
      const lease = this.deps.captureConfidentialConnection(input.nodeId);
      if (this.closed || !snapshot || !native || native.nodeId !== input.nodeId || native.profileId !== input.profileId
        || !hasSynchronousAuthority(lease ?? undefined)) throw refused();
      // Reserve capacity and profile before dispatch, including starts still awaiting their handle.
      if (this.operations.size >= 64 || [...this.operations].some(entry => entry.native.nodeId === native.nodeId
        && entry.native.profileId === native.profileId && !entry.abort.signal.aborted
        && (!entry.view || !terminal.has(entry.view.state)))) throw refused();
      const abort = new AbortController();
      const deadline = Date.now() + 300_000;
      op = { owner, snapshot: { ...snapshot }, native: { ...native }, lease: lease!, abort, deadline,
        timer: setTimeout(() => { this.stop(op!, 'expired'); this.operations.delete(op!); }, 300_000), busy: false, submitted: false };
      op.timer.unref(); this.operations.add(op);
      this.requireCurrent(op);
      const pending = this.deps.worker.request(native.nodeId, COORDINATOR_TO_NODE.CODEX_DEVICE_LOGIN_START, { profileId: native.profileId, owner });
      // A late start response still owns a native child and must be cancelled after local abort.
      void pending.then(raw => {
        if (!op!.abort.signal.aborted) return;
        const parsed = CodexDeviceLoginViewSchema.safeParse(raw);
        if (parsed.success) this.cancelNative(op!, parsed.data.handle);
      }, () => undefined);
      const raw = await this.wait(op, pending);
      try {
        const view = this.validateView(op, raw);
        if (!['starting', 'awaiting_handoff'].includes(view.state)) throw refused();
        op.view = view;
      }
      catch {
        const parsed = CodexDeviceLoginViewSchema.safeParse(raw);
        if (parsed.success) this.cancelNative(op, parsed.data.handle);
        throw refused();
      }
      op.deadline = op.view.expiresAt;
      clearTimeout(op.timer);
      op.timer = setTimeout(() => { this.stop(op!, 'expired'); this.operations.delete(op!); }, op.deadline - Date.now());
      op.timer.unref();
      this.requireCurrent(op);
      return { ...op.view };
    } catch {
      if (op) this.stop(op, 'failed');
      throw refused();
    }
  }

  async read(handle: string, owner: CodexDeviceLoginOwner): Promise<CodexDeviceLoginView> {
    const op = this.owned(handle, owner);
    try {
      if (op.abort.signal.aborted) return { ...op.view! };
      this.requireCurrent(op);
      const raw = await this.wait(op, this.deps.worker.request(op.native.nodeId, COORDINATOR_TO_NODE.CODEX_DEVICE_LOGIN_READ, { handle, owner: op.owner }));
      this.requireCurrent(op);
      op.view = this.validateView(op, raw);
      if (terminal.has(op.view.state)) this.stop(op, op.view.state);
      return { ...op.view };
    } catch { this.stop(op, 'failed'); throw refused(); }
  }

  async cancel(handle: string, owner: CodexDeviceLoginOwner): Promise<CodexDeviceLoginView> {
    const op = this.owned(handle, owner);
    this.stop(op, 'cancelled');
    return { ...op.view! };
  }

  async fill(input: { loginHandle: string; profileId: string; targetId: string }, owner: CodexDeviceLoginOwner): Promise<BrowserDeviceLoginFillResult> {
    const op = this.owned(input.loginHandle, owner);
    // A second caller must not mutate the first caller's operation.
    if (op.busy || op.submitted || op.abort.signal.aborted) throw refused();
    op.busy = true;
    try {
      this.requireCurrent(op);
      if (op.view?.state !== 'awaiting_handoff') throw refused();
      if (!op.target) {
        const target = await this.wait(op, this.deps.resolveTarget({ profileId: input.profileId, targetId: input.targetId }, op.owner));
        this.requireCurrent(op);
        if (target.browserProfileId !== input.profileId || target.targetId !== input.targetId) throw refused();
        const browserLease = this.deps.captureConfidentialConnection(target.browserNodeId);
        if (!hasSynchronousAuthority(browserLease ?? undefined)) throw refused();
        op.browserLease = browserLease!;
        op.target = Object.freeze({ ...target });
        this.requireCurrent(op);
        op.driver = createBrowserDeviceLoginDriver({ ...this.deps,
          isCurrent: () => this.current(op), isApproved: (metadata, id) => this.approved(op, metadata, id),
        }, { ...target, expectedIdentity: op.native.expectedIdentity, expiresAt: op.deadline });
        const context = await this.wait(op, op.driver.context(op.abort.signal));
        this.requireCurrent(op);
        op.metadata = BrowserDeviceLoginMetadataSchema.parse({
          operationHandle: op.view.handle, ownerSessionId: op.owner.sessionId, ownerGeneration: op.owner.generation,
          nativeNodeId: op.native.nodeId, nativeProfileId: op.native.profileId, nativeComputerName: op.native.computerName,
          browserNodeId: target.browserNodeId, browserProfileId: target.browserProfileId, browserComputerName: target.computerName,
          targetId: target.targetId, origin: 'https://auth.openai.com', expectedIdentity: op.native.expectedIdentity,
          extensionInstanceId: context.extensionInstanceId, extensionGeneration: context.extensionGeneration,
          documentId: context.documentId, expiresAt: op.deadline,
        });
        const existing = this.deps.approvals.findDeviceLoginRequest(op.metadata);
        const approval = existing ?? this.deps.approvals.createRequest({ instanceId: op.owner.sessionId, provider: 'codex',
          profileId: target.browserProfileId, targetId: target.targetId, toolName: 'browser.fill_device_login', action: 'fill_device_login',
          actionClass: 'credential', origin: 'https://auth.openai.com', deviceLogin: op.metadata, expiresAt: op.deadline,
          proposedGrant: { mode: 'per_action', allowedOrigins: [{ scheme: 'https', hostPattern: 'auth.openai.com', includeSubdomains: false }],
            allowedActionClasses: ['credential'], allowExternalNavigation: false, autonomous: false } });
        op.approvalId = approval.requestId;
      }
      if (op.target.browserProfileId !== input.profileId || op.target.targetId !== input.targetId) throw refused();
      this.requireCurrent(op);
      const approval = this.deps.approvals.findDeviceLoginRequest(op.metadata!);
      if (!approval || approval.requestId !== op.approvalId || !isDeepStrictEqual(approval.deviceLogin, op.metadata)
        || approval.expiresAt !== op.deadline || approval.expiresAt <= Date.now()) throw refused();
      if (approval.status === 'pending') return { status: 'requires_approval', requestId: approval.requestId, operation: { ...op.view! } };
      if (!this.approved(op, op.metadata!, op.approvalId!)) throw refused();
      await this.wait(op, op.driver!.attest(op.metadata!, op.approvalId!, op.abort.signal));
      this.requireApproved(op);
      const binding = { browserNodeId: op.target.browserNodeId, profileId: op.target.browserProfileId, targetId: op.target.targetId,
        origin: 'https://auth.openai.com', documentId: op.metadata!.documentId, extensionInstanceId: op.target.extensionInstanceId,
        extensionGeneration: op.target.extensionGeneration, approvalId: op.approvalId!, expectedIdentity: op.native.expectedIdentity };
      let delivered = false;
      const transfer = this.deps.transfers.register({ nodeId: op.native.nodeId, handle: op.view!.handle, owner: op.owner,
        binding, expiresAt: op.deadline, signal: op.abort.signal, isCurrent: () => this.approved(op, op.metadata!, op.approvalId!),
        deliver: async (code, signal) => {
          this.requireApproved(op);
          await op.driver!.fillAndSubmit(code, signal);
          this.requireApproved(op); delivered = true;
        } });
      op.transferCancel = transfer.cancel;
      this.requireApproved(op);
      const raw = await this.wait(op, this.deps.worker.request(op.native.nodeId, COORDINATOR_TO_NODE.CODEX_DEVICE_LOGIN_HANDOFF,
        { handle: op.view!.handle, owner: op.owner, binding, transferId: transfer.transferId }));
      this.requireApproved(op);
      if (!delivered) throw refused();
      op.view = this.validateView(op, raw);
      if (!['awaiting_login', 'verifying', 'authenticated'].includes(op.view.state)) throw refused();
      op.submitted = true;
      return { status: 'submitted', operation: { ...op.view } };
    } catch { this.stop(op, 'failed'); throw refused(); }
    finally { op.busy = false; op.transferCancel?.(); op.transferCancel = undefined; }
  }

  invalidateOwner(sessionId: string): void {
    for (const op of this.operations) if (op.owner.sessionId === sessionId) this.stop(op, 'cancelled');
  }
  invalidateNode(nodeId: string): void {
    for (const op of this.operations) if (op.native.nodeId === nodeId || op.target?.browserNodeId === nodeId) this.stop(op, 'cancelled');
  }
  shutdown(): void {
    this.closed = true;
    for (const op of this.operations) { this.stop(op, 'cancelled'); clearTimeout(op.timer); }
    this.operations.clear();
  }
  private owned(handle: string, owner: CodexDeviceLoginOwner): Operation {
    const op = [...this.operations].find(entry => entry.view?.handle === handle);
    if (!op || op.owner.sessionId !== owner.sessionId || op.owner.generation !== owner.generation) throw refused();
    return op;
  }
  private current(op: Operation): boolean {
    try {
      const current = this.deps.resolveOwner(op.owner);
      const native = this.deps.resolveNative({ nodeId: op.native.nodeId, profileId: op.native.profileId }, op.owner);
      return !this.closed && !op.abort.signal.aborted && Date.now() < op.deadline && !!current
        && current.object === op.snapshot.object && current.restartEpoch === op.snapshot.restartEpoch
        && current.adapterGeneration === op.snapshot.adapterGeneration && isDeepStrictEqual(native, op.native) && hasSynchronousAuthority(op.lease)
        && (!op.target || (hasSynchronousAuthority(op.target.isCurrent) && hasSynchronousAuthority(op.browserLease))) && hasSynchronousAuthority(this.deps.protectionEnabled);
    } catch { return false; }
  }
  private requireCurrent(op: Operation): void { if (!this.current(op)) throw refused(); }
  private approved(op: Operation, metadata: BrowserDeviceLoginMetadata, id: string): boolean {
    try {
      if (!this.current(op) || id !== op.approvalId || !isDeepStrictEqual(metadata, op.metadata)) return false;
      const approval = this.deps.approvals.findDeviceLoginRequest(metadata);
      return !!approval && approval.requestId === id && approval.status === 'approved' && approval.expiresAt === op.deadline
        && approval.expiresAt > Date.now() && isDeepStrictEqual(approval.deviceLogin, metadata) && this.current(op);
    } catch { return false; }
  }
  private requireApproved(op: Operation): void { if (!this.approved(op, op.metadata!, op.approvalId!)) throw refused(); }
  private validateView(op: Operation, raw: unknown): CodexDeviceLoginView {
    const view = CodexDeviceLoginViewSchema.parse(raw);
    if (view.nodeId !== op.native.nodeId || view.profileId !== op.native.profileId || view.expectedIdentity !== op.native.expectedIdentity
      || view.expiresAt > op.deadline || view.expiresAt <= Date.now() || (op.view && (view.handle !== op.view.handle || view.expiresAt !== op.deadline))) throw refused();
    return view;
  }
  private stop(op: Operation, state: CodexDeviceLoginView['state']): void {
    if (op.abort.signal.aborted) return;
    if (op.view && !terminal.has(op.view.state)) op.view = { ...op.view, state };
    op.abort.abort(); op.transferCancel?.();
    if (op.view) {
      try { this.deps.approvals.invalidateDeviceLoginRequests(op.view.handle, op.owner); } catch { /* Cleanup remains best effort. */ }
      try { this.deps.ledger.invalidateDevice(op.view.handle); } catch { /* No private errors escape. */ }
      if (state !== 'authenticated') this.cancelNative(op, op.view.handle);
    }
    if (op.driver) void op.driver.cancel().catch(() => undefined);
  }
  private cancelNative(op: Operation, handle: string): void {
    try {
      if (hasSynchronousAuthority(op.lease)) void this.deps.worker.request(op.native.nodeId, COORDINATOR_TO_NODE.CODEX_DEVICE_LOGIN_CANCEL,
        { handle, owner: op.owner }).catch(() => undefined);
    } catch { /* Native lease expiry bounds disconnected cleanup. */ }
  }
  private wait<T>(op: Operation, pending: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => { op.abort.signal.removeEventListener('abort', abort); reject(refused()); };
      if (op.abort.signal.aborted) abort(); else op.abort.signal.addEventListener('abort', abort, { once: true });
      void pending.then(resolve, () => reject(refused())).finally(() => op.abort.signal.removeEventListener('abort', abort));
    });
  }
}
