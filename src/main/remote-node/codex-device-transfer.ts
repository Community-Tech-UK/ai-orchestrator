import { randomUUID } from 'node:crypto';
import type { CodexDeviceLoginBinding, CodexDeviceLoginOwner } from '../providers/account-pool/codex-device-login';

const refused = () => new Error('codex_device_transfer_refused');
const bindingKeys = ['browserNodeId', 'profileId', 'targetId', 'origin', 'documentId',
  'extensionInstanceId', 'extensionGeneration', 'approvalId', 'expectedIdentity'] as const;

export interface CodexDeviceTransferInput {
  nodeId: string;
  handle: string;
  owner: CodexDeviceLoginOwner;
  binding: CodexDeviceLoginBinding;
  expiresAt: number;
  signal: AbortSignal;
  /** Captured native/browser connections, current owner and exact live approval. */
  isCurrent: () => boolean;
  /** Resolves only after verified private fill and the one approved submit. */
  deliver: (code: string, signal: AbortSignal) => Promise<void>;
}

export interface CodexDeviceTransferPayload {
  transferId: string;
  handle: string;
  owner: CodexDeviceLoginOwner;
  binding: CodexDeviceLoginBinding;
  expiresAt: number;
  code: string;
}

interface Transfer {
  input: CodexDeviceTransferInput;
  abort: AbortController;
  consumed: boolean;
  cleanup: () => void;
}

/** Private rendezvous only. No code is retained in a registry entry or returned. */
export class CodexDeviceTransferRegistry {
  private readonly transfers = new Map<string, Transfer>();
  private closed = false;

  register(input: CodexDeviceTransferInput): { transferId: string; cancel: () => void } {
    const remaining = input.expiresAt - Date.now();
    if (this.closed || this.transfers.size >= 64 || !Number.isSafeInteger(input.expiresAt)
      || remaining <= 0 || remaining > 300_000 || input.signal.aborted
      || !input.nodeId || !input.handle || !input.owner.sessionId || !input.owner.generation
      || input.binding.origin !== 'https://auth.openai.com'
      || bindingKeys.some((key) => typeof input.binding[key] !== 'string' || !input.binding[key])
      || !affirmative(input.isCurrent)) throw refused();
    if ([...this.transfers.values()].some((entry) => entry.input.nodeId === input.nodeId
      && entry.input.handle === input.handle)) throw refused();
    const transferId = randomUUID();
    const abort = new AbortController();
    const cancel = () => { this.transfers.delete(transferId); entry.cleanup(); abort.abort(); };
    const timer = setTimeout(cancel, remaining);
    timer.unref();
    const entry: Transfer = {
      input: { ...input, owner: { ...input.owner }, binding: { ...input.binding } },
      abort, consumed: false,
      cleanup: () => { clearTimeout(timer); input.signal.removeEventListener('abort', cancel); },
    };
    this.transfers.set(transferId, entry);
    input.signal.addEventListener('abort', cancel, { once: true });
    if (input.signal.aborted) cancel();
    return { transferId, cancel };
  }

  async receive(nodeId: string, payload: CodexDeviceTransferPayload,
    incomingTransport: (() => boolean) | null): Promise<{ delivered: true }> {
    const entry = this.transfers.get(payload.transferId);
    if (!entry || entry.consumed) throw refused();
    const expected = entry.input;
    if (nodeId !== expected.nodeId || payload.handle !== expected.handle
      || payload.owner.sessionId !== expected.owner.sessionId || payload.owner.generation !== expected.owner.generation
      || payload.expiresAt !== expected.expiresAt
      || bindingKeys.some((key) => payload.binding[key] !== expected.binding[key])) throw refused();
    // Burn before any callback or await; a failed or ambiguous write cannot retry.
    entry.consumed = true;
    const current = () => this.transfers.get(payload.transferId) === entry
      && !entry.abort.signal.aborted && Date.now() < expected.expiresAt
      && affirmative(expected.isCurrent) && affirmative(incomingTransport);
    try {
      if (!current() || typeof payload.code !== 'string' || !/^[A-Z0-9-]{4,64}$/.test(payload.code)) throw refused();
      await abortable(expected.deliver(payload.code, entry.abort.signal), entry.abort.signal);
      if (!current()) throw refused();
      return { delivered: true };
    } catch {
      throw refused();
    } finally {
      this.transfers.delete(payload.transferId);
      entry.cleanup();
      entry.abort.abort();
    }
  }

  shutdown(): void {
    this.closed = true;
    for (const entry of this.transfers.values()) { entry.cleanup(); entry.abort.abort(); }
    this.transfers.clear();
  }

  invalidateNode(nodeId: string): void {
    for (const [id, entry] of this.transfers) {
      if (entry.input.nodeId !== nodeId && entry.input.binding.browserNodeId !== nodeId) continue;
      this.transfers.delete(id);
      entry.cleanup();
      entry.abort.abort();
    }
  }
}

function affirmative(check: (() => boolean) | null): boolean {
  try {
    const proof = check?.();
    if (proof === true) return true;
    void Promise.resolve(proof).catch(() => undefined);
    return false;
  } catch { return false; }
}

function abortable(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(refused()); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
