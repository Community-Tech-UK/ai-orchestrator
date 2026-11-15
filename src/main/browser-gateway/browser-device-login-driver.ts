import type { BrowserDeviceLoginMetadata } from '@contracts/types/browser';
import { BrowserDeviceLoginMetadataSchema } from '@contracts/schemas/browser';
import type { BrowserExtensionContactStateReader } from './browser-extension-contact-state';
import { hasSynchronousAuthority, type BrowserExtensionSendCommandRequest } from './browser-extension-command-delivery';
import { isExactSecureCredentialWriteCompletion, supportsBrowserExtensionCodexDeviceHandoff } from './browser-extension-credential-compatibility';
import type { BrowserOneTimeCodeFillLedger, DeviceCodeFillScope } from './browser-one-time-code-submit';

export interface BrowserDeviceLoginDestination {
  browserNodeId: string;
  browserProfileId: string;
  targetId: string;
  tabId: number;
  extensionInstanceId: string;
  extensionGeneration: string;
  expectedIdentity: string;
  expiresAt: number;
}

export interface BrowserDeviceLoginDriverDependencies {
  commands: {
    sendCommand(request: BrowserExtensionSendCommandRequest): Promise<unknown>;
    cancelCommand(queueKey: string, commandId: string): boolean;
  };
  contacts: BrowserExtensionContactStateReader;
  ledger: Pick<BrowserOneTimeCodeFillLedger, 'recordDevice' | 'consumeDevice' | 'invalidateDevice'>;
  captureConfidentialConnection(nodeId: string): (() => boolean) | null;
  isCurrent(): boolean;
  isApproved(metadata: BrowserDeviceLoginMetadata, approvalId: string): boolean;
  protectionEnabled(): boolean;
  now?: () => number;
}

export interface BrowserDeviceLoginContext {
  documentId: string;
  extensionInstanceId: string;
  extensionGeneration: string;
  identityMatches: true;
}

const refused = () => new Error('codex_device_handoff_refused');
const documentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Private composition only. Never expose its code-bearing method as a tool/RPC. */
export function createBrowserDeviceLoginDriver(
  deps: BrowserDeviceLoginDriverDependencies,
  input: BrowserDeviceLoginDestination,
) {
  const destination = Object.freeze({ ...input });
  const now = deps.now ?? Date.now;
  let confidential: (() => boolean) | null;
  try {
    confidential = deps.captureConfidentialConnection(destination.browserNodeId);
    if (!Number.isSafeInteger(destination.tabId) || destination.tabId < 0
      || !Number.isSafeInteger(destination.expiresAt) || destination.expiresAt <= now()
      || destination.expiresAt > now() + 300_000
      || ['browserNodeId', 'browserProfileId', 'targetId', 'extensionInstanceId', 'extensionGeneration', 'expectedIdentity']
        .some((key) => typeof destination[key as keyof BrowserDeviceLoginDestination] !== 'string'
          || !(destination[key as keyof BrowserDeviceLoginDestination] as string).trim())
      || !hasSynchronousAuthority(confidential ?? undefined)) throw refused();
  } catch { throw refused(); }

  let phase = 'new';
  let context: BrowserDeviceLoginContext | undefined;
  let metadata: BrowserDeviceLoginMetadata | undefined;
  let approvalId: string | undefined;
  let scope: DeviceCodeFillScope | undefined;
  const signals = new Set<AbortSignal>();
  const stopped = new AbortController();

  function invalidate(next = 'failed'): void {
    phase = next;
    if (scope) deps.ledger.invalidateDevice(scope.operationHandle);
    stopped.abort();
  }
  function authorized(cancelling = false): boolean {
    try {
      return (cancelling || (!stopped.signal.aborted && ![...signals].some((signal) => signal.aborted)))
        && now() < destination.expiresAt
        && hasSynchronousAuthority(confidential ?? undefined)
        && hasSynchronousAuthority(deps.isCurrent)
        && hasSynchronousAuthority(deps.protectionEnabled)
        && supportsBrowserExtensionCodexDeviceHandoff(deps.contacts, destination.browserNodeId,
          destination.extensionInstanceId, destination.extensionGeneration)
        && (!metadata || hasSynchronousAuthority(() => deps.isApproved(metadata!, approvalId!)));
    } catch { return false; }
  }
  function requireAuthority(cancelling = false): void {
    if (!authorized(cancelling)) throw refused();
  }
  function binding(): Record<string, unknown> {
    if (!metadata || !approvalId) throw refused();
    return { operationHandle: metadata.operationHandle, approvalId, expectedIdentity: destination.expectedIdentity,
      expiresAt: destination.expiresAt, extensionInstanceId: destination.extensionInstanceId,
      extensionGeneration: destination.extensionGeneration, documentId: metadata.documentId };
  }
  async function send(command: BrowserExtensionSendCommandRequest['command'], payload: Record<string, unknown>, cancelling = false): Promise<unknown> {
    let active = true;
    let commandId: string | undefined;
    let settled = false;
    const queueKey = `node:${destination.browserNodeId}`;
    const cancelPending = () => {
      active = false;
      if (commandId) {
        try { deps.commands.cancelCommand(queueKey, commandId); } catch { /* Never expose transport errors. */ }
        commandId = undefined;
      }
    };
    const guard = () => { if (!active) throw refused(); requireAuthority(cancelling); };
    guard();
    const timeoutMs = Math.min(10_000, destination.expiresAt - now());
    const observed = cancelling ? [] : [...signals, stopped.signal];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectWait: () => void = () => undefined;
    const interrupted = new Promise<never>((_, reject) => {
      rejectWait = () => { cancelPending(); reject(refused()); };
      timer = setTimeout(rejectWait, timeoutMs);
      for (const signal of observed) signal.addEventListener('abort', rejectWait, { once: true });
    });
    try {
      const pending = deps.commands.sendCommand({ queueKey, command,
        target: { tabId: destination.tabId, extensionInstanceId: destination.extensionInstanceId }, payload,
        timeoutMs, executionTimeoutMs: timeoutMs, undeliveredWaitMs: timeoutMs,
        onQueued: (id) => { commandId = id; },
        beforeDelivery: guard, authorizeDeviceCommand: () => active && authorized(cancelling) });
      const result = await Promise.race([pending, interrupted]);
      guard();
      settled = true;
      return result;
    } catch { throw refused(); }
    finally {
      active = false;
      if (!settled) cancelPending();
      clearTimeout(timer);
      for (const signal of observed) signal.removeEventListener('abort', rejectWait);
      delete payload['code'];
    }
  }

  return {
    async context(signal: AbortSignal): Promise<BrowserDeviceLoginContext> {
      try {
        if (phase !== 'new') throw refused();
        phase = 'context'; signals.add(signal);
        const result = await send('codex_device_context', { expectedIdentity: destination.expectedIdentity });
        if (!exact(result, ['documentId', 'extensionInstanceId', 'extensionGeneration', 'identityMatches'])
          || typeof result['documentId'] !== 'string' || !documentIdPattern.test(result['documentId'])
          || result['extensionInstanceId'] !== destination.extensionInstanceId
          || result['extensionGeneration'] !== destination.extensionGeneration || result['identityMatches'] !== true) throw refused();
        context = Object.freeze({ documentId: result['documentId'], extensionInstanceId: destination.extensionInstanceId,
          extensionGeneration: destination.extensionGeneration, identityMatches: true });
        phase = 'observed';
        return { ...context };
      } catch { invalidate(); throw refused(); }
    },
    async attest(inputMetadata: BrowserDeviceLoginMetadata, approvedId: string, signal: AbortSignal): Promise<void> {
      try {
        if (phase !== 'observed' || !context) throw refused();
        const parsed = BrowserDeviceLoginMetadataSchema.safeParse(inputMetadata);
        if (!parsed.success || typeof approvedId !== 'string' || !approvedId.trim() || approvedId.length > 200) throw refused();
        const candidate = parsed.data;
        if (candidate.documentId !== context.documentId
          || (['browserNodeId', 'browserProfileId', 'targetId', 'extensionInstanceId', 'extensionGeneration', 'expectedIdentity', 'expiresAt'] as const)
            .some((key) => candidate[key] !== destination[key])) throw refused();
        metadata = Object.freeze(candidate); approvalId = approvedId;
        scope = Object.freeze({ instanceId: metadata.ownerSessionId, ownerGeneration: metadata.ownerGeneration,
          profileId: metadata.browserProfileId, targetId: metadata.targetId, origin: metadata.origin,
          operationHandle: metadata.operationHandle, nativeNodeId: metadata.nativeNodeId, nativeProfileId: metadata.nativeProfileId,
          browserNodeId: metadata.browserNodeId, expectedIdentity: metadata.expectedIdentity, approvalId,
          documentId: metadata.documentId, extensionInstanceId: metadata.extensionInstanceId,
          extensionGeneration: metadata.extensionGeneration, expiresAt: metadata.expiresAt });
        phase = 'attesting'; signals.add(signal);
        const result = await send('codex_device_attest', { binding: binding() });
        if (!exact(result, ['completed', 'deviceDocumentId']) || result['completed'] !== true
          || result['deviceDocumentId'] !== metadata.documentId) throw refused();
        phase = 'ready';
      } catch { invalidate(); throw refused(); }
    },
    async fillAndSubmit(code: string, signal: AbortSignal): Promise<void> {
      try {
        if (phase !== 'ready' || !scope || !metadata || !/^[A-Za-z0-9]{9}$/.test(code)) throw refused();
        phase = 'filling'; signals.add(signal);
        const result = await send('codex_device_fill', { binding: binding(), deviceDocumentId: metadata.documentId, code });
        code = '';
        if (!isExactSecureCredentialWriteCompletion(result)) throw refused();
        requireAuthority();
        if (!deps.ledger.recordDevice(scope)) throw refused();
        requireAuthority();
        if (!deps.ledger.consumeDevice(scope)) throw refused();
        phase = 'submitting';
        const submitted = await send('codex_device_submit', { binding: binding(), deviceDocumentId: metadata.documentId });
        if (!isExactSecureCredentialWriteCompletion(submitted)) throw refused();
        phase = 'done';
      } catch { invalidate(); throw refused(); }
      finally { code = ''; }
    },
    async cancel(): Promise<void> {
      const alreadyStopped = phase === 'cancelled' || phase === 'done';
      invalidate('cancelled');
      if (alreadyStopped || !metadata || !authorized(true)) return;
      try {
        const result = await send('codex_device_cancel', { binding: binding() }, true);
        if (!exact(result, ['completed']) || result['completed'] !== true) throw refused();
      } catch { /* Best effort; expired/disconnected extension operations erase themselves. */ }
    },
  };
}
