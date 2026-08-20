import { detectAndroidIntent } from '../channels/android-intent';
import { isAndroidAutomationReady } from '../remote-node';
import type { Instance } from '../../shared/types/instance.types';
import type { NodePlacementPrefs, WorkerNodeInfo } from '../../shared/types/worker-node.types';

/**
 * Pure support helpers for the `run_on_node` MCP tool implementation in
 * orchestrator-tools-step.ts, extracted to keep that file under the LOC
 * ceiling and to make spawn-time validation directly unit-testable.
 */

/**
 * Effective spawn depth of an instance for the recursion guard (claude2_todo
 * #18). Unifies the two lineage systems: locally-orchestrated children carry a
 * real `depth` (set from `parent.depth + 1`), while `run_on_node`-spawned
 * instances record their depth in `metadata.spawnDepth` (they deliberately
 * don't set `parentId`, to avoid coupling remote spawns to parent-termination
 * / hibernation cascades). The larger of the two wins.
 */
export function effectiveSpawnDepth(instance: Instance | undefined): number {
  if (!instance) return 0;
  const metaDepth = instance.metadata?.['spawnDepth'];
  const fromMeta = typeof metaDepth === 'number' && Number.isFinite(metaDepth) ? metaDepth : 0;
  const fromField = typeof instance.depth === 'number' && Number.isFinite(instance.depth) ? instance.depth : 0;
  return Math.max(fromMeta, fromField, 0);
}

export interface RunOnNodePlacementArgs {
  prompt: string;
  requiresBrowser?: boolean;
  requiresAndroid?: boolean;
  androidDeviceKind?: 'emulator' | 'physical' | 'any';
}

export function buildRunOnNodePlacement(args: RunOnNodePlacementArgs): NodePlacementPrefs | undefined {
  const requiresAndroid = args.requiresAndroid ?? detectAndroidIntent(args.prompt);
  const placement: NodePlacementPrefs = {
    ...(args.requiresBrowser === true ? { requiresBrowser: true } : {}),
    ...(requiresAndroid
      ? {
          requiresAndroid: true,
          androidDeviceKind: args.androidDeviceKind ?? 'any',
        }
      : {}),
  };
  return Object.keys(placement).length > 0 ? placement : undefined;
}

export function assertNodeSatisfiesPlacement(
  node: WorkerNodeInfo,
  placement: NodePlacementPrefs | undefined,
): void {
  if (!placement) {
    return;
  }
  if (placement.requiresBrowser && !node.capabilities.hasBrowserMcp) {
    throw new Error(
      `Worker node "${node.name}" is not browser-automation ready. Enable browser automation or choose a node with hasBrowserMcp=true.`,
    );
  }
  if (placement.requiresAndroid && !isAndroidAutomationReady(node.capabilities)) {
    throw new Error(
      `Worker node "${node.name}" is not Android-automation ready. Enable Android automation and verify adb/AVD/device readiness before running this test.`,
    );
  }
  if (
    placement.requiresAndroid &&
    placement.androidDeviceKind === 'physical' &&
    !node.capabilities.androidAutomation?.connectedDevices.some((device) =>
      (device.kind === 'usb' || device.kind === 'wifi') && device.state === 'device'
    )
  ) {
    throw new Error(
      `Worker node "${node.name}" does not report an online physical Android device.`,
    );
  }
}

/**
 * Reject a run_on_node spawn whose CLI is not installed on the target node.
 *
 * Without this, the worker accepts the spawn RPC (on Windows the shell wrapper
 * even yields a live pid for a missing binary), the first turn dies silently,
 * and the caller gets an instance that goes idle with only its own prompt in
 * the buffer — a healthy node that looks broken. Nodes that predate CLI
 * capability reporting advertise an empty list; they keep the old behaviour
 * rather than having every spawn rejected.
 */
export function assertNodeSupportsCli(
  node: WorkerNodeInfo,
  cliType: string,
  requestedExplicitly: boolean,
): void {
  const supported = node.capabilities?.supportedClis ?? [];
  if (supported.length === 0) {
    return;
  }
  if (supported.some((cli) => cli.toLowerCase() === cliType.toLowerCase())) {
    return;
  }
  const available = supported.join(', ');
  const origin = requestedExplicitly
    ? `provider "${cliType}" is`
    : `no provider was given and the default resolved to "${cliType}", which is`;
  throw new Error(
    `run_on_node rejected: ${origin} not installed on worker node "${node.name}". `
    + `CLIs available on this node: ${available}. Pass one of those via "provider".`,
  );
}
