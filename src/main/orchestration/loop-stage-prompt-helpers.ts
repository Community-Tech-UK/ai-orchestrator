import {
  coercePendingInput,
  type LoopConfig,
  type LoopPendingInput,
} from '../../shared/types/loop.types';

export type PendingInputLike = string | LoopPendingInput;

export function renderPendingInput(input: PendingInputLike, index: number): string {
  const item = coercePendingInput(input);
  return `${index + 1}. [${item.kind}/${item.source}] ${item.message}`;
}

export function renderCapsRemaining(config: LoopConfig, iterationSeq: number): string {
  const iterationRemaining = config.caps.maxIterations === null
    ? 'unbounded iterations'
    : `${Math.max(0, config.caps.maxIterations - iterationSeq)} iteration(s)`;
  const tokenCap = config.caps.maxTokens === null ? 'unbounded tokens' : `${config.caps.maxTokens} token cap`;
  const costCap = config.caps.maxCostCents === null ? 'unbounded cost' : `${config.caps.maxCostCents} cent cap`;
  return `${iterationRemaining}; ${tokenCap}; ${costCap}`;
}
