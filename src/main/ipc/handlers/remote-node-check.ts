/**
 * Lazy check for remote worker-node availability.
 * Extracted into its own file so tests can mock it without pulling in the
 * full remote-node barrel (which transitively loads ElectronStore).
 */

/**
 * Check whether a remote worker node is connected and reachable.
 * Uses a lazy require to avoid pulling the full remote-node barrel at
 * module load time (same pattern as resolveExecutionLocation in instance-lifecycle).
 */
export function isRemoteNodeReachable(nodeId: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWorkerNodeRegistry } = require('../../remote-node') as typeof import('../../remote-node');
    const registry = getWorkerNodeRegistry();
    const node = registry.getNode(nodeId);
    return node?.status === 'connected';
  } catch {
    return false;
  }
}
