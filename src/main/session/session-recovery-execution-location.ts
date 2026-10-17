import type { ExecutionLocation } from '../../shared/types/worker-node.types';

/** Keep recovered filesystem context on its original machine; legacy records remain unspecified. */
export function normalizeRecoveryExecutionLocation(value: unknown): ExecutionLocation | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid recovery execution location.');
  }
  const record = value as Record<string, unknown>;
  if (record['type'] === 'local' && record['nodeId'] === undefined) return { type: 'local' };
  const nodeId = record['nodeId'];
  if (record['type'] !== 'remote' || typeof nodeId !== 'string' || nodeId.length === 0
    || nodeId.length > 200 || nodeId.trim() !== nodeId
    || Array.from(nodeId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Invalid recovery execution location.');
  }
  return { type: 'remote', nodeId };
}
