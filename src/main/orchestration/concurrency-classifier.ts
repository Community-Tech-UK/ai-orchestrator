/**
 * Tool concurrency safety classification for orchestration.
 *
 * Inspired by Claude Code StreamingToolExecutor's isConcurrencySafe pattern.
 * Classifies operations as safe/unsafe for parallel execution and groups
 * them into schedulable batches.
 */

export interface OperationDescriptor {
  type: 'read' | 'write' | 'git' | 'shell' | 'analysis';
  target?: string;
}

export type ConcurrencySafety = 'concurrent' | 'needs_target_check' | 'exclusive';

const ALWAYS_CONCURRENT = new Set(['read', 'analysis']);
const NEEDS_TARGET_CHECK = new Set(['write', 'git', 'shell']);

/**
 * Classify a single operation's inherent safety (without overlap context).
 */
export function classifyOperationSafety(operation: OperationDescriptor): ConcurrencySafety {
  if (ALWAYS_CONCURRENT.has(operation.type)) return 'concurrent';
  if (NEEDS_TARGET_CHECK.has(operation.type)) {
    return operation.target ? 'needs_target_check' : 'exclusive';
  }
  return 'exclusive';
}

/**
 * Given a set of operations, group them into parallelizable batches.
 *
 * Rules:
 * - 'concurrent' ops all go in the first batch
 * - 'needs_target_check' ops with distinct targets go in the same batch
 * - 'needs_target_check' ops with overlapping targets go in separate batches
 * - 'exclusive' ops each get their own batch
 *
 * Returns batches in execution order — run each batch in parallel,
 * batches run sequentially.
 */
export function scheduleOperations(operations: OperationDescriptor[]): OperationDescriptor[][] {
  if (operations.length === 0) return [];

  const concurrent: OperationDescriptor[] = [];
  const targetChecked: OperationDescriptor[] = [];
  const exclusive: OperationDescriptor[] = [];

  for (const op of operations) {
    const safety = classifyOperationSafety(op);
    if (safety === 'concurrent') concurrent.push(op);
    else if (safety === 'needs_target_check') targetChecked.push(op);
    else exclusive.push(op);
  }

  const batches: OperationDescriptor[][] = [];

  // Group target-checked ops by target overlap
  const targetBatches = groupByTargetOverlap(targetChecked);

  // Concurrent targets (for overlap checking against target-checked ops)
  const concurrentTargets = new Set(concurrent.map(o => o.target).filter((t): t is string => t !== undefined));

  // First batch: all concurrent ops + first group of non-overlapping target-checked ops
  // Only merge the first target batch into the concurrent batch if no targets overlap
  const firstBatch = [...concurrent];
  let targetBatchStart = 0;
  if (targetBatches.length > 0) {
    const firstTargetGroup = targetBatches[0];
    const firstGroupTargets = firstTargetGroup.map(o => o.target).filter((t): t is string => t !== undefined);
    const hasOverlap = firstGroupTargets.some(t => concurrentTargets.has(t));
    if (!hasOverlap) {
      firstBatch.push(...firstTargetGroup);
      targetBatchStart = 1;
    }
  }
  if (firstBatch.length > 0) {
    batches.push(firstBatch);
  }

  // Remaining target batches
  for (let i = targetBatchStart; i < targetBatches.length; i++) {
    batches.push(targetBatches[i]);
  }

  // Exclusive ops: one per batch
  for (const op of exclusive) {
    batches.push([op]);
  }

  return batches;
}

/**
 * Group operations so that no two ops in the same group share a target.
 * Uses a greedy coloring algorithm.
 */
function groupByTargetOverlap(ops: OperationDescriptor[]): OperationDescriptor[][] {
  if (ops.length === 0) return [];

  const groups: OperationDescriptor[][] = [];

  for (const op of ops) {
    let placed = false;
    for (const group of groups) {
      const targets = new Set(group.map(o => o.target));
      if (!targets.has(op.target)) {
        group.push(op);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push([op]);
    }
  }

  return groups;
}
