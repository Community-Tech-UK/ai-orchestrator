import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

const LIFETIME_MS = 5 * 60_000;
const OUTPUT_LIMIT = 32_768;
const TERMINAL = new Set(['authenticated', 'failed', 'cancelled', 'expired']);
const DEVICE_URL = 'https://auth.openai.com/codex/device';
const BINDING_KEYS = ['browserNodeId', 'profileId', 'targetId', 'origin', 'documentId', 'extensionInstanceId', 'extensionGeneration', 'approvalId', 'expectedIdentity'] as const;

export interface CodexDeviceLoginChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
}
export interface CodexDeviceLoginOwner { sessionId: string; generation: string }
export interface CodexDeviceLoginBinding {
  browserNodeId: string;
  profileId: string;
  targetId: string;
  origin: string;
  documentId: string;
  extensionInstanceId: string;
  extensionGeneration: string;
  approvalId: string;
  expectedIdentity: string;
}
export interface CodexDeviceLoginView {
  handle: string;
  profileId: string;
  provider: 'codex';
  nodeId: string;
  expectedIdentity: string;
  expiresAt: number;
  state: 'starting' | 'awaiting_handoff' | 'reserved' | 'delivering' | 'awaiting_login' | 'verifying' | 'authenticated' | 'failed' | 'cancelled' | 'expired';
  error?: string;
}
export interface CodexDeviceLoginDependencies {
  /** Trusted campaign/account policy, never inferred from the request or browser. */
  expectedIdentity: string;
  nodeId: string;
  prepareHome: (profileId: string) => string;
  spawn: (home: string) => CodexDeviceLoginChild;
  /** Must close its owned native probe when aborted; never log raw protocol errors. */
  probeIdentity: (home: string, signal: AbortSignal) => Promise<string | null>;
  /** Synchronous proof of current approval, identity and generation; only true permits delivery. */
  authorizeHandoff: (binding: CodexDeviceLoginBinding, view: CodexDeviceLoginView, owner: CodexDeviceLoginOwner) => boolean;
  /** Private trusted driver only: must honor abort and recheck approval immediately before write. */
  deliver: (code: string, binding: CodexDeviceLoginBinding & { operationHandle: string; expiresAt: number }, signal: AbortSignal) => Promise<void>;
}
interface Operation {
  view: CodexDeviceLoginView;
  owner: CodexDeviceLoginOwner;
  home: string;
  child: CodexDeviceLoginChild;
  abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  promptTimer?: ReturnType<typeof setTimeout>;
  output: string;
  bytes: number;
  code?: string;
  reservation?: string;
  binding?: CodexDeviceLoginBinding;
  exited?: boolean;
  authorizing?: boolean;
}

/**
 * Provider-owned memory only operation, composed by the private worker device-login dispatcher.
 * No method returns CLI output, a code, a home path, or credentials.
 * Constructor dependencies belong to trusted composition, never caller payloads.
 */
export class CodexDeviceLoginService {
  readonly #operations = new Map<string, Operation>();
  #closed = false;

  constructor(private readonly deps: CodexDeviceLoginDependencies) {
    if (!deps.expectedIdentity || !deps.nodeId) throw new Error('login_policy_required');
  }

  start(input: { profileId: string; expectedIdentity: string }, owner: CodexDeviceLoginOwner): CodexDeviceLoginView {
    if (this.#closed) throw new Error('login_service_closed');
    if (!owner.sessionId || !owner.generation) throw new Error('owner_required');
    if (input.expectedIdentity !== this.deps.expectedIdentity) throw new Error('identity_not_authorized');
    if ([...this.#operations.values()].some((op) => op.view.profileId === input.profileId && !TERMINAL.has(op.view.state))) {
      throw new Error('profile_in_use');
    }
    // Bounded status retention. Active operations are never evicted.
    if (this.#operations.size >= 64) {
      const completed = [...this.#operations.values()].find((op) => TERMINAL.has(op.view.state));
      if (!completed) throw new Error('login_capacity_reached');
      this.#operations.delete(completed.view.handle);
    }
    let home: string;
    try { home = this.deps.prepareHome(input.profileId); } catch {
      throw new Error('fresh_profile_required');
    }
    let child: CodexDeviceLoginChild;
    try { child = this.deps.spawn(home); } catch { throw new Error('login_spawn_failed'); }
    const op: Operation = {
      view: { handle: randomUUID(), profileId: input.profileId, provider: 'codex', nodeId: this.deps.nodeId,
        expectedIdentity: input.expectedIdentity, expiresAt: Date.now() + LIFETIME_MS, state: 'starting' },
      owner: { ...owner }, home, child, abort: new AbortController(), output: '', bytes: 0,
    };
    this.#operations.set(op.view.handle, op);
    op.timer = setTimeout(() => this.finish(op, 'expired', 'operation_expired'), LIFETIME_MS);
    op.timer.unref();
    op.promptTimer = setTimeout(() => this.finish(op, 'failed', 'unsupported_login_output'), 15_000);
    op.promptTimer.unref();
    child.stdout.on('data', (chunk: Buffer | string) => this.capture(op, chunk, true));
    child.stderr.on('data', (chunk: Buffer | string) => this.capture(op, chunk, false));
    child.stdout.on('error', () => this.finish(op, 'failed', 'login_stream_failed'));
    child.stderr.on('error', () => this.finish(op, 'failed', 'login_stream_failed'));
    child.on('error', () => this.finish(op, 'failed', 'login_process_failed'));
    child.once('close', (code: number | null) => {
      op.exited = true;
      if (TERMINAL.has(op.view.state)) return;
      if (code !== 0) this.finish(op, 'failed', 'login_process_failed');
      else if (op.view.state === 'awaiting_login') void this.verify(op);
      else if (op.view.state !== 'delivering') this.finish(op, 'failed', 'unapproved_completion');
    });
    return { ...op.view };
  }

  read(handle: string, owner: CodexDeviceLoginOwner): CodexDeviceLoginView {
    return { ...this.owned(handle, owner).view };
  }

  activeCount(): number {
    return [...this.#operations.values()].filter(op => !TERMINAL.has(op.view.state)).length;
  }

  cancel(handle: string, owner: CodexDeviceLoginOwner): CodexDeviceLoginView {
    const op = this.owned(handle, owner);
    this.finish(op, 'cancelled');
    return { ...op.view };
  }

  reserveHandoff(handle: string, owner: CodexDeviceLoginOwner, binding: CodexDeviceLoginBinding): string {
    const op = this.owned(handle, owner);
    if (op.view.state !== 'awaiting_handoff') throw new Error('handoff_unavailable');
    this.authorize(op, binding, 'awaiting_handoff');
    op.binding = { ...binding };
    op.reservation = randomUUID();
    op.view.state = 'reserved';
    return op.reservation;
  }

  async deliverHandoff(reservation: string, owner: CodexDeviceLoginOwner, binding: CodexDeviceLoginBinding): Promise<void> {
    const found = [...this.#operations.values()].find((op) => op.reservation === reservation);
    if (!found) throw new Error('handoff_unavailable');
    const op = this.owned(found.view.handle, owner);
    if (op.view.state !== 'reserved' || !op.code || !op.binding) throw new Error('handoff_unavailable');
    if (Object.keys(op.binding).some((key) => op.binding![key as keyof CodexDeviceLoginBinding] !== binding[key as keyof CodexDeviceLoginBinding])) {
      throw new Error('handoff_binding_mismatch');
    }
    this.authorize(op, binding, 'reserved');
    // Consume before any asynchronous delivery. Ambiguous failure cannot retry.
    op.reservation = undefined;
    op.view.state = 'delivering';
    const code = op.code;
    op.code = undefined;
    try {
      await untilAborted(this.deps.deliver(code, { ...op.binding, operationHandle: op.view.handle, expiresAt: op.view.expiresAt }, op.abort.signal), op.abort.signal);
    } catch {
      if (op.abort.signal.aborted) throw new Error('operation_inactive');
      this.finish(op, 'failed', 'handoff_failed');
      throw new Error('handoff_failed');
    }
    if (op.abort.signal.aborted || Date.now() >= op.view.expiresAt) {
      this.finish(op, 'expired', 'operation_expired');
      throw new Error('operation_inactive');
    }
    op.view.state = 'awaiting_login';
    if (op.exited) await this.verify(op);
  }

  /** Coordinator loss and app shutdown use the same owner-contained cancellation. */
  shutdown(): void {
    this.#closed = true;
    for (const op of this.#operations.values()) this.finish(op, 'cancelled');
  }

  private owned(handle: string, owner: CodexDeviceLoginOwner): Operation {
    const op = this.#operations.get(handle);
    if (!op || op.owner.sessionId !== owner.sessionId || op.owner.generation !== owner.generation) throw new Error('operation_not_owned');
    if (Date.now() >= op.view.expiresAt) this.finish(op, 'expired', 'operation_expired');
    return op;
  }

  private authorize(op: Operation, binding: CodexDeviceLoginBinding, state: 'awaiting_handoff' | 'reserved'): void {
    if (op.authorizing) throw new Error('handoff_unavailable');
    if (binding.origin !== new URL(DEVICE_URL).origin || binding.expectedIdentity !== op.view.expectedIdentity
      || BINDING_KEYS.some((key) => typeof binding[key] !== 'string' || !binding[key])) throw new Error('handoff_not_authorized');
    op.authorizing = true;
    try {
      const proof = this.deps.authorizeHandoff({ ...binding }, { ...op.view }, { ...op.owner });
      if (proof !== true) {
        // Reject an accidentally asynchronous runtime dependency immediately.
        // Contain its eventual rejection without logging private error details.
        void Promise.resolve(proof).catch(() => undefined);
        throw new Error('handoff_not_authorized');
      }
    }
    catch { throw new Error('handoff_not_authorized'); }
    finally { op.authorizing = false; }
    if (Date.now() >= op.view.expiresAt) this.finish(op, 'expired', 'operation_expired');
    if (op.abort.signal.aborted || op.view.state !== state) throw new Error('operation_inactive');
  }

  private capture(op: Operation, chunk: Buffer | string, stdout: boolean): void {
    if (TERMINAL.has(op.view.state)) return;
    op.bytes += Buffer.byteLength(chunk);
    if (op.bytes > OUTPUT_LIMIT) { this.finish(op, 'failed', 'login_output_limit'); return; }
    if (!stdout || op.view.state !== 'starting') return;
    op.output += chunk.toString();
    // Pinned source: openai/codex rust-v0.169.0 login/src/device_code_auth.rs:136–163.
    // Length is deliberately not inferred from browser control count. Preserve display spelling.
    const plain = stripVTControlCharacters(op.output).replace(/\r\n/g, '\n');
    const match = /1\. Open this link in your browser and sign in to your account\n[ \t]+(\S+)\n\s*2\. Enter this one-time code \(expires in (\d+) minutes\)\n[ \t]+([^\n]+)\n/.exec(plain);
    if (!match) return;
    const code = match[3].trim();
    if (match[1] !== DEVICE_URL || !/^[A-Z0-9-]{4,64}$/.test(code) || Number(match[2]) < 1) {
      this.finish(op, 'failed', 'unsupported_login_output'); return;
    }
    // A delayed prompt must not extend the provider's lifetime.
    op.view.expiresAt = Math.min(op.view.expiresAt, op.view.expiresAt - LIFETIME_MS + Number(match[2]) * 60_000);
    clearTimeout(op.timer);
    op.timer = setTimeout(() => this.finish(op, 'expired', 'operation_expired'), op.view.expiresAt - Date.now());
    op.timer.unref();
    clearTimeout(op.promptTimer);
    op.output = '';
    op.code = code;
    op.view.state = 'awaiting_handoff';
  }

  private async verify(op: Operation): Promise<void> {
    op.view.state = 'verifying';
    try {
      const identity = await untilAborted(this.deps.probeIdentity(op.home, op.abort.signal), op.abort.signal);
      if (op.abort.signal.aborted) return;
      if (Date.now() >= op.view.expiresAt) { this.finish(op, 'expired', 'operation_expired'); return; }
      this.finish(op, identity === op.view.expectedIdentity ? 'authenticated' : 'failed', identity === op.view.expectedIdentity ? undefined : 'identity_mismatch');
    } catch { this.finish(op, 'failed', 'identity_probe_failed'); }
  }

  private finish(op: Operation, state: CodexDeviceLoginView['state'], error?: string): void {
    if (TERMINAL.has(op.view.state)) return;
    op.view.state = state;
    if (error) op.view.error = error;
    op.abort.abort();
    clearTimeout(op.timer);
    clearTimeout(op.promptTimer);
    op.output = '';
    op.code = undefined;
    op.reservation = undefined;
    op.binding = undefined;
    if (!op.exited) {
      try {
        if (!op.child.kill('SIGKILL')) op.view.error = 'login_cleanup_failed';
      } catch { op.view.error = 'login_cleanup_failed'; }
    }
    op.child.stdout.destroy();
    op.child.stderr.destroy();
  }
}

/** Settles our operation even if an external callback does not settle on abort. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('operation_inactive'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
