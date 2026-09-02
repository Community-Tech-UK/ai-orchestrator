import {
  RlmWorkerRpcError,
  RlmWorkerRpcTimeoutError,
  type RlmWorkerRequest,
  type RlmWorkerResult,
} from './rlm-worker-port';
import {
  UnifiedMemoryWorkerRpcError,
  UnifiedMemoryWorkerRpcTimeoutError,
  type UnifiedMemoryWorkerRequest,
  type UnifiedMemoryWorkerResult,
} from './unified-memory-worker-port';
import { ContextWorkerRpcTimeoutError } from './context-worker-rpc';
import type { ContextWorkerRpcMsg } from './context-worker-protocol';

type RejectingPostRpc = (message: ContextWorkerRpcMsg) => Promise<unknown>;

export async function invokeRlmWorkerRpc<TRequest extends RlmWorkerRequest>(
  postRpc: RejectingPostRpc,
  id: number,
  request: TRequest,
  timeoutMs: number,
): Promise<RlmWorkerResult<TRequest>> {
  try {
    return await postRpc({ type: 'rlm-request', id, request }) as RlmWorkerResult<TRequest>;
  } catch (error) {
    if (error instanceof ContextWorkerRpcTimeoutError) {
      throw new RlmWorkerRpcTimeoutError(`RLM worker request timed out after ${timeoutMs}ms`);
    }
    throw new RlmWorkerRpcError(error instanceof Error ? error.message : String(error));
  }
}

export async function invokeUnifiedMemoryWorkerRpc<
  TRequest extends UnifiedMemoryWorkerRequest,
>(
  postRpc: RejectingPostRpc,
  id: number,
  request: TRequest,
  timeoutMs: number,
): Promise<UnifiedMemoryWorkerResult<TRequest>> {
  try {
    return await postRpc({ type: 'unified-memory-request', id, request }) as UnifiedMemoryWorkerResult<TRequest>;
  } catch (error) {
    if (error instanceof ContextWorkerRpcTimeoutError) {
      throw new UnifiedMemoryWorkerRpcTimeoutError(
        `Unified-memory worker request timed out after ${timeoutMs}ms`,
      );
    }
    throw new UnifiedMemoryWorkerRpcError(error instanceof Error ? error.message : String(error));
  }
}
