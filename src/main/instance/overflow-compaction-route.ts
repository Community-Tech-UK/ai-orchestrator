/**
 * Overflow compaction routing (A1-O, Step 16c).
 *
 * When a session runs out of room, the recovery path used to trim only
 * Harness's own buffers, leaving the provider's session full — so the retry
 * re-sent the same overflow. This route picks the right recovery per
 * provider:
 *
 *   1. an adapter with its own `compactContext` (Codex app-server, local
 *      models after 16a, OpenCode after 11b) compacts in place, then the
 *      buffers are trimmed;
 *   2. Claude and OpenCode without native support keep buffers-only recovery
 *      (their native reactive compaction already owns the turn);
 *   3. every other provider goes through the real restart-with-summary path,
 *      with the interrupted request carried into the new session exactly once.
 *
 * Where the outcome is buffers-only, an honest notice says the provider's own
 * session is unchanged.
 */

import { getLogger } from '../logging/logger';
import { getCliDisplayName } from '../cli/adapters/adapter-factory';
import type { CompactionExecutionOptions, CompactionRecoveryOwner } from '../context/compaction-execution-options';
import type { FileAttachment, Instance } from '../../shared/types/instance.types';
import type { InternalInputSource } from '../../shared/types/input-provenance.types';

const logger = getLogger('OverflowCompactionRoute');

export type OverflowCompactionMethod = 'native' | 'restart-with-summary' | 'buffers-only';

export interface OverflowCompactionOutcome {
  method: OverflowCompactionMethod;
  /** True when a restart-with-summary already carried the interrupted request. */
  resumeDelivered: boolean;
}

export interface OverflowResumeTurn {
  text: string;
  attachments?: FileAttachment[];
  internalSource?: InternalInputSource;
  recoveryOwner?: CompactionRecoveryOwner;
}

export interface OverflowCompactionDeps {
  getInstance(instanceId: string): Instance | undefined;
  getAdapter(instanceId: string): unknown;
  /** Trim Harness's own buffers (the old whole behaviour). */
  compactBuffers(instanceId: string, instance: Instance): Promise<void> | void;
  /** The context engine's real compaction entry point. */
  compactInstance(
    instanceId: string,
    options?: CompactionExecutionOptions,
  ): Promise<{ success: boolean; method: 'native' | 'restart-with-summary'; busy?: boolean; resumeDelivered?: boolean }>;
  emitSystemNotice(instance: Instance, content: string): void;
  /** How long to wait for an idle moment when a live turn blocks compaction. */
  waitMs?: number;
}

interface NativeCompactionAdapter {
  compactContext?: () => Promise<boolean>;
  getName?: () => string;
}

function isNativeCompactionAdapter(adapter: unknown): adapter is NativeCompactionAdapter {
  return typeof (adapter as NativeCompactionAdapter | undefined)?.compactContext === 'function';
}

function adapterName(adapter: unknown): string | undefined {
  return (adapter as NativeCompactionAdapter | undefined)?.getName?.();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function compactForOverflow(
  deps: OverflowCompactionDeps,
  instanceId: string,
  resumeTurn?: OverflowResumeTurn,
  fallbackOwner?: CompactionRecoveryOwner,
): Promise<OverflowCompactionOutcome> {
  const owner = resumeTurn?.recoveryOwner ?? fallbackOwner;
  owner?.assertCurrent();
  const instance = deps.getInstance(instanceId);
  if (!instance) return { method: 'buffers-only', resumeDelivered: false };
  const adapter = deps.getAdapter(instanceId);
  const name = adapterName(adapter);
  const buffersOnly = async (): Promise<OverflowCompactionOutcome> => {
    owner?.assertProviderDispatchCurrent();
    await deps.compactBuffers(instanceId, instance);
    owner?.assertCurrent();
    const provider = getCliDisplayName((instance.provider as never) ?? 'claude');
    try {
      deps.emitSystemNotice(instance, `Trimmed Harness's copy of the history; ${provider}'s own session is unchanged.`);
    } catch { /* An advisory notice cannot break recovery. */ }
    return { method: 'buffers-only', resumeDelivered: false };
  };

  // Rule 1: the provider compacts itself — real reduction, same session.
  if (isNativeCompactionAdapter(adapter)) {
    try {
      if (await adapter.compactContext!()) {
        owner?.assertProviderDispatchCurrent();
        await deps.compactBuffers(instanceId, instance);
        owner?.assertCurrent();
        return { method: 'native', resumeDelivered: false };
      }
    } catch (err) {
      logger.warn('Native overflow compaction failed; trying the provider fallback', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  owner?.assertCurrent();

  // Rule 2: Claude and OpenCode without native support already exhaust their
  // own reactive compaction before reporting overflow; a restart here would
  // create a second owner.
  if (name === 'claude-cli' || name === 'opencode-acp') {
    return buffersOnly();
  }

  // Rule 3: everyone else gets the real summary path, carrying the cut-off
  // request into the new session exactly once.
  const options: CompactionExecutionOptions = {
    trigger: 'overflow',
    ...(resumeTurn ? { resumeTurn: { text: resumeTurn.text, attachments: resumeTurn.attachments, internalSource: resumeTurn.internalSource } } : {}),
    ...(owner ? { recoveryOwner: owner } : {}),
  };
  let result = await deps.compactInstance(instanceId, options);
  if (!result.success && result.busy) {
    // A live turn blocks compaction; give the turn a bounded chance to end.
    await sleep(deps.waitMs ?? 10_000);
    owner?.assertCurrent();
    result = await deps.compactInstance(instanceId, options);
  }
  if (result.success) {
    return {
      method: result.method,
      resumeDelivered: result.method === 'restart-with-summary' && Boolean(resumeTurn) && result.resumeDelivered === true,
    };
  }

  // A failed restart can be a caller veto even while its recovery epoch is current.
  owner?.assertProviderDispatchCurrent();
  return buffersOnly();
}
