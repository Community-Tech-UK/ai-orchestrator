import {
  LOOP_CLI_METHODS,
  LoopCliListPayloadSchema,
  LoopCliListResultSchema,
  LoopCliResumePayloadSchema,
  LoopCliResumeResultSchema,
  type LoopCliOperations,
  type LoopCliRpcMethod,
} from './loop-cli-contracts';

export type { LoopCliOperations } from './loop-cli-contracts';

export function isLoopCliRpcMethod(method: string): method is LoopCliRpcMethod {
  return Object.values(LOOP_CLI_METHODS).includes(method as LoopCliRpcMethod);
}

/**
 * True for the loop methods that start work rather than describe it. `resume`
 * begins a fresh agentic iteration with provider spend and workspace write
 * access; `list` is read-only. The RPC server uses this to apply the
 * spawn-depth guard to the former only.
 */
export function isLoopCliMutationMethod(method: string): boolean {
  return method === LOOP_CLI_METHODS.resume;
}

export async function dispatchLoopCliRpc(
  method: LoopCliRpcMethod,
  payload: Record<string, unknown>,
  operations: LoopCliOperations | null,
): Promise<unknown> {
  if (!operations) {
    throw new Error('Loop CLI operations unavailable');
  }
  switch (method) {
    case LOOP_CLI_METHODS.list: {
      const parsed = LoopCliListPayloadSchema.parse(payload);
      return LoopCliListResultSchema.parse(await operations.list(parsed));
    }
    case LOOP_CLI_METHODS.resume: {
      const parsed = LoopCliResumePayloadSchema.parse(payload);
      return LoopCliResumeResultSchema.parse(await operations.resume(parsed));
    }
  }
}
