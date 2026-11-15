import { randomUUID } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import { isDeepStrictEqual } from 'node:util';
import { WebSocket } from 'ws';
import { CodexDeviceLoginService, type CodexDeviceLoginDependencies } from '../main/providers/account-pool/codex-device-login';
import { discoverCodexDeviceLoginExecutable, probeCodexDeviceLoginIdentity } from '../main/providers/account-pool/codex-device-login-native';
import { prepareCodexDeviceLoginHome, spawnCodexDeviceLogin } from '../main/providers/account-pool/codex-device-login-runtime';
import { COORDINATOR_TO_NODE, NODE_TO_COORDINATOR, RPC_ERROR_CODES } from '../main/remote-node/worker-node-rpc';
import {
  CodexDeviceLoginPolicySchema, CodexDeviceLoginStartParamsSchema, CodexDeviceLoginOwnedParamsSchema,
  CodexDeviceLoginHandoffParamsSchema, CodexDeviceLoginDeliverAckSchema, CodexDeviceLoginViewSchema,
  type CodexDeviceLoginHandoffParams,
} from '../main/remote-node/codex-device-login-rpc';
import type { RpcMessage } from './worker-rpc-types';
import type { WorkerConfig } from './worker-config';

interface Dependencies {
  config: Pick<WorkerConfig, 'nodeId' | 'codexDeviceLogin'>;
  getSocket: () => WebSocket | null;
  getRegistered: () => boolean;
  getToken: () => string;
  createService?: (deps: CodexDeviceLoginDependencies) => CodexDeviceLoginService;
}
interface Transfer {
  params: CodexDeviceLoginHandoffParams;
  current: () => boolean;
  socket: WebSocket;
}
interface PendingAck {
  socket: WebSocket;
  current: () => boolean;
  settle: (ok: boolean) => void;
}
const METHODS = new Set<string>([COORDINATOR_TO_NODE.CODEX_DEVICE_LOGIN_START, COORDINATOR_TO_NODE.CODEX_DEVICE_LOGIN_READ,
  COORDINATOR_TO_NODE.CODEX_DEVICE_LOGIN_CANCEL, COORDINATOR_TO_NODE.CODEX_DEVICE_LOGIN_HANDOFF]);

/** Dedicated private dispatcher. Neither codes nor validation errors enter the ordinary RPC notifier. */
export class WorkerCodexDeviceLogin {
  private service?: CodexDeviceLoginService;
  private readonly transfers = new Map<string, Transfer>();
  private readonly spentTransfers = new Set<string>();
  private readonly pending = new Map<string, PendingAck>();
  constructor(private readonly deps: Dependencies) {}

  enabled(): boolean { return CodexDeviceLoginPolicySchema.safeParse(this.deps.config.codexDeviceLogin).success; }

  handleMessage(message: RpcMessage, source: WebSocket | undefined): boolean {
    if (typeof message.id === 'string' && message.id.startsWith('codex-device-private-') && !message.method) {
      const ack = this.pending.get(message.id);
      if (ack && source === ack.socket && ack.current()) ack.settle(!message.error && CodexDeviceLoginDeliverAckSchema.safeParse(message.result).success);
      return true;
    }
    if (!message.method?.startsWith('provider.codexDevice.')) return false;
    // Notifications and unknown device methods never reach generic logging or execution.
    if (message.id === undefined) return true;
    void this.dispatch(message, source);
    return true;
  }

  shutdown(): void {
    this.service?.shutdown(); this.service = undefined;
    for (const ack of this.pending.values()) ack.settle(false);
    this.pending.clear(); this.transfers.clear(); this.spentTransfers.clear();
  }

  activeCount(): number {
    return this.service?.activeCount() ?? 0;
  }

  private lease(source: WebSocket | undefined): () => boolean {
    const socket = source as (WebSocket & { _socket?: unknown }) | undefined;
    const transport = socket?._socket;
    return () => Boolean(socket && this.deps.getSocket() === socket && this.deps.getRegistered()
      && socket.readyState === WebSocket.OPEN && socket._socket === transport && transport instanceof TLSSocket
      && transport.encrypted === true && transport.authorized === true && !transport.destroyed);
  }

  private async dispatch(message: RpcMessage, source: WebSocket | undefined): Promise<void> {
    const current = this.lease(source);
    try {
      if (!METHODS.has(message.method!) || message.scope !== 'service' || !current() || !this.enabled()) throw new Error();
      const service = this.getService();
      let result;
      if (message.method === COORDINATOR_TO_NODE.CODEX_DEVICE_LOGIN_START) {
        const params = CodexDeviceLoginStartParamsSchema.parse(message.params);
        const policy = CodexDeviceLoginPolicySchema.parse(this.deps.config.codexDeviceLogin);
        if (!current()) throw new Error();
        result = service.start({ profileId: params.profileId, expectedIdentity: policy.expectedIdentity }, params.owner);
      } else if (message.method === COORDINATOR_TO_NODE.CODEX_DEVICE_LOGIN_HANDOFF) {
        const params = CodexDeviceLoginHandoffParamsSchema.parse(message.params);
        if (this.spentTransfers.has(params.transferId) || this.spentTransfers.size >= 256 || this.transfers.has(params.handle)) throw new Error();
        service.read(params.handle, params.owner);
        this.spentTransfers.add(params.transferId);
        this.transfers.set(params.handle, { params, current, socket: source! });
        try {
          const reservation = service.reserveHandoff(params.handle, params.owner, params.binding);
          await service.deliverHandoff(reservation, params.owner, params.binding);
          result = service.read(params.handle, params.owner);
        } finally { this.transfers.delete(params.handle); }
      } else {
        const params = CodexDeviceLoginOwnedParamsSchema.parse(message.params);
        result = message.method === COORDINATOR_TO_NODE.CODEX_DEVICE_LOGIN_CANCEL
          ? service.cancel(params.handle, params.owner) : service.read(params.handle, params.owner);
      }
      const safe = CodexDeviceLoginViewSchema.parse(result);
      if (current()) source!.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: safe }));
    } catch {
      // Fixed, code-free failure even for schema errors, spawn failures or malicious ACK bodies.
      if (source === this.deps.getSocket() && source?.readyState === WebSocket.OPEN) {
        try { source.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: RPC_ERROR_CODES.UNAUTHORIZED, message: 'device_login_request_refused' } })); } catch { /* disconnected */ }
      }
    }
  }

  private getService(): CodexDeviceLoginService {
    if (this.service) return this.service;
    const policy = CodexDeviceLoginPolicySchema.parse(this.deps.config.codexDeviceLogin);
    // Discovery is deferred until a policy-enabled request on a verified TLS connection.
    let executable: string | undefined;
    const deps: CodexDeviceLoginDependencies = {
      expectedIdentity: policy.expectedIdentity, nodeId: this.deps.config.nodeId,
      prepareHome: profileId => { executable ??= discoverCodexDeviceLoginExecutable(); return prepareCodexDeviceLoginHome(profileId); },
      spawn: home => spawnCodexDeviceLogin(executable!, home),
      probeIdentity: (home, signal) => probeCodexDeviceLoginIdentity(executable!, home, signal),
      authorizeHandoff: (binding, view, owner) => {
        const transfer = this.transfers.get(view.handle);
        return Boolean(transfer?.current() && isDeepStrictEqual(transfer.params.binding, binding)
          && isDeepStrictEqual(transfer.params.owner, owner) && binding.expectedIdentity === policy.expectedIdentity);
      },
      deliver: (code, binding, signal) => this.deliver(code, binding.operationHandle, signal),
    };
    this.service = (this.deps.createService ?? (options => new CodexDeviceLoginService(options)))(deps);
    return this.service;
  }

  private deliver(code: string, handle: string, signal: AbortSignal): Promise<void> {
    const transfer = this.transfers.get(handle);
    if (!transfer || !transfer.current() || signal.aborted) return Promise.reject(new Error('private_delivery_failed'));
    const view = this.service!.read(handle, transfer.params.owner);
    return new Promise((resolve, reject) => {
      const id = `codex-device-private-${randomUUID()}`;
      const settle = (ok: boolean) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (ok && transfer.current() && !signal.aborted && Date.now() < view.expiresAt) resolve();
        else reject(new Error('private_delivery_failed'));
      };
      const abort = () => settle(false);
      const timer = setTimeout(abort, Math.max(1, Math.min(60_000, view.expiresAt - Date.now()))); timer.unref();
      this.pending.set(id, { socket: transfer.socket, current: transfer.current, settle });
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (!transfer.current() || signal.aborted) { settle(false); return; }
        const frame = JSON.stringify({ jsonrpc: '2.0', id, method: NODE_TO_COORDINATOR.CODEX_DEVICE_LOGIN_DELIVER,
          token: this.deps.getToken(), scope: 'service', params: { ...transfer.params, expiresAt: view.expiresAt, code } });
        if (!transfer.current() || signal.aborted) { settle(false); return; }
        transfer.socket.send(frame, error => { if (error) settle(false); });
      } catch { settle(false); }
    });
  }
}
