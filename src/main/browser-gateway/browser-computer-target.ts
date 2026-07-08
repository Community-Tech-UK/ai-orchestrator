import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { resolveWorkerNodeTarget } from '../remote-node/worker-node-registry';

export interface BrowserComputerDescriptor {
  nodeId?: string;
  nodeName?: string;
}

export interface BrowserComputerTargetRequest {
  nodeId?: string;
  computer?: string;
}

export interface BrowserComputerTargetResolution {
  nodeId?: string;
  nodeName?: string;
  localOnly: boolean;
}

export type BrowserComputerTargetResult =
  | { ok: true; target: BrowserComputerTargetResolution }
  | { ok: false; reason: string };

const LOCAL_COMPUTER_ALIASES = new Set([
  'local',
  'localhost',
  'coordinator',
  'thiscomputer',
  'thismachine',
]);

export function resolveBrowserComputerTarget(
  request: BrowserComputerTargetRequest,
  options: {
    connectedNodes?: WorkerNodeInfo[];
    descriptors?: BrowserComputerDescriptor[];
  },
): BrowserComputerTargetResult {
  const explicitNodeId = cleanOptional(request.nodeId);
  const computer = cleanOptional(request.computer);
  if (!computer) {
    return { ok: true, target: { ...(explicitNodeId ? { nodeId: explicitNodeId } : {}), localOnly: false } };
  }

  const normalizedComputer = normalizeComputerLookup(computer);
  if (LOCAL_COMPUTER_ALIASES.has(normalizedComputer)) {
    if (explicitNodeId) {
      return {
        ok: false,
        reason: `browser_computer_mismatch: "${computer}" is local but nodeId "${explicitNodeId}" was also supplied`,
      };
    }
    return { ok: true, target: { localOnly: true } };
  }

  const connectedNodes = options.connectedNodes ?? [];
  const registryMatch = resolveWorkerNodeTarget(computer, connectedNodes);
  if ('nodeId' in registryMatch) {
    if (explicitNodeId && explicitNodeId !== registryMatch.nodeId) {
      return {
        ok: false,
        reason: `browser_computer_mismatch: "${computer}" resolved to nodeId "${registryMatch.nodeId}", not "${explicitNodeId}"`,
      };
    }
    const node = connectedNodes.find((candidate) => candidate.id === registryMatch.nodeId);
    return {
      ok: true,
      target: {
        nodeId: registryMatch.nodeId,
        ...(node?.name ? { nodeName: node.name } : {}),
        localOnly: false,
      },
    };
  }

  const descriptorMatch = (options.descriptors ?? []).find((descriptor) =>
    matchesDescriptorComputer(descriptor, normalizedComputer),
  );
  if (descriptorMatch?.nodeId) {
    if (explicitNodeId && explicitNodeId !== descriptorMatch.nodeId) {
      return {
        ok: false,
        reason: `browser_computer_mismatch: "${computer}" resolved to nodeId "${descriptorMatch.nodeId}", not "${explicitNodeId}"`,
      };
    }
    return {
      ok: true,
      target: {
        nodeId: descriptorMatch.nodeId,
        ...(descriptorMatch.nodeName ? { nodeName: descriptorMatch.nodeName } : {}),
        localOnly: false,
      },
    };
  }

  if (explicitNodeId) {
    return { ok: true, target: { nodeId: explicitNodeId, localOnly: false } };
  }

  return {
    ok: false,
    reason: browserComputerNotFoundReason(computer, connectedNodes, options.descriptors ?? []),
  };
}

export function matchesBrowserComputerTarget(
  descriptor: BrowserComputerDescriptor,
  target: BrowserComputerTargetResolution,
): boolean {
  if (target.localOnly) {
    return !descriptor.nodeId;
  }
  return !target.nodeId || descriptor.nodeId === target.nodeId;
}

function matchesDescriptorComputer(
  descriptor: BrowserComputerDescriptor,
  normalizedComputer: string,
): boolean {
  return (
    (descriptor.nodeId ? normalizeComputerLookup(descriptor.nodeId) === normalizedComputer : false) ||
    (descriptor.nodeName ? normalizeComputerLookup(descriptor.nodeName) === normalizedComputer : false)
  );
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeComputerLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['\u2018\u2019]s\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function browserComputerNotFoundReason(
  requested: string,
  connectedNodes: WorkerNodeInfo[],
  descriptors: BrowserComputerDescriptor[],
): string {
  const available = new Set<string>(['local']);
  for (const node of connectedNodes) {
    available.add(node.name || node.id);
  }
  for (const descriptor of descriptors) {
    if (descriptor.nodeName) {
      available.add(descriptor.nodeName);
    } else if (descriptor.nodeId) {
      available.add(descriptor.nodeId);
    }
  }
  return `browser_computer_not_found: no Browser Gateway computer matching "${requested}". Available computers: ${[...available].join(', ')}`;
}
