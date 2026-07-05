import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type {
  WorkerNodeInfo,
  WorkerNodeCapabilities,
  NodePlacementPrefs,
  NodePlatform,
} from '../../shared/types/worker-node.types';

const logger = getLogger('WorkerNodeRegistry');

export class WorkerNodeRegistry extends EventEmitter {
  private nodes = new Map<string, WorkerNodeInfo>();

  private static instance: WorkerNodeRegistry;

  static getInstance(): WorkerNodeRegistry {
    if (!this.instance) {
      this.instance = new WorkerNodeRegistry();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    (this.instance as unknown) = undefined;
  }

  private constructor() {
    super();
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  registerNode(info: WorkerNodeInfo): void {
    this.nodes.set(info.id, { ...info });
    logger.info('Node registered', {
      node: info.name,
      nodeId: info.id,
      platform: info.capabilities.platform,
      address: info.address,
    });
    this.emit('node:connected', this.nodes.get(info.id)!);
  }

  deregisterNode(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.nodes.delete(nodeId);
    logger.info('Node deregistered', { node: node.name, nodeId });
    this.emit('node:disconnected', node);
  }

  getNode(nodeId: string): WorkerNodeInfo | undefined {
    return this.nodes.get(nodeId);
  }

  getAllNodes(): WorkerNodeInfo[] {
    return [...this.nodes.values()];
  }

  getHealthyNodes(): WorkerNodeInfo[] {
    return [...this.nodes.values()].filter(n => n.status === 'connected');
  }

  // ---------------------------------------------------------------------------
  // Updates
  // ---------------------------------------------------------------------------

  updateNodeMetrics(nodeId: string, partial: Partial<WorkerNodeInfo>): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const safePartial = { ...partial };
    delete safePartial.id;
    const updated = { ...node, ...safePartial, id: nodeId };
    this.nodes.set(nodeId, updated);
    this.emit('node:updated', updated);
  }

  updateHeartbeat(nodeId: string, capabilities: WorkerNodeCapabilities): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const updated: WorkerNodeInfo = {
      ...node,
      capabilities: { ...capabilities },
      lastHeartbeat: Date.now(),
      status: node.status !== 'connected' ? 'connected' : node.status,
    };
    this.nodes.set(nodeId, updated);
    this.emit('node:updated', updated);
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  selectNode(prefs: NodePlacementPrefs): WorkerNodeInfo | null {
    const candidates = this.getHealthyNodes();
    if (candidates.length === 0) return null;

    let bestNode: WorkerNodeInfo | null = null;
    let bestScore = -Infinity;

    for (const node of candidates) {
      const score = this.scoreNode(node, prefs);
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }

    // Return null if no candidate reached a positive score
    if (bestScore <= 0) return null;

    logger.info('Node selected', { node: bestNode?.name, nodeId: bestNode?.id, score: bestScore });
    return bestNode;
  }

  private scoreNode(node: WorkerNodeInfo, prefs: NodePlacementPrefs): number {
    const caps = node.capabilities;

    // --- Hard filters ---
    if (node.activeInstances >= caps.maxConcurrentInstances) return -Infinity;
    // Browser intent requires actual automation wiring. A Chrome-only node can
    // report readiness/setup state, but spawned agents will not receive browser
    // tools unless the node advertises hasBrowserMcp.
    if (prefs.requiresBrowser && !caps.hasBrowserMcp) return -Infinity;
    if (prefs.requiresAndroid && !isAndroidAutomationReady(caps)) return -Infinity;
    if (
      prefs.requiresAndroid &&
      prefs.androidDeviceKind === 'physical' &&
      !hasPhysicalAndroidDevice(caps)
    ) {
      return -Infinity;
    }
    if (prefs.requiresGpu && !caps.gpuName) return -Infinity;
    if (prefs.requiresCli && !caps.supportedClis.includes(prefs.requiresCli)) return -Infinity;
    if (
      prefs.requiresWorkingDirectory &&
      !caps.workingDirectories.includes(prefs.requiresWorkingDirectory)
    ) {
      return -Infinity;
    }

    // --- Base capability match ---
    let score = 100;

    // Platform preference (+20)
    if (prefs.preferPlatform && caps.platform === prefs.preferPlatform) {
      score += 20;
    }

    // Available memory ratio (+30)
    if (caps.totalMemoryMB > 0) {
      score += (caps.availableMemoryMB / caps.totalMemoryMB) * 30;
    }

    // Spare capacity ratio (+25)
    if (caps.maxConcurrentInstances > 0) {
      score += (1 - node.activeInstances / caps.maxConcurrentInstances) * 25;
    }

    // Latency bonus (+0..10, or +5 if unknown)
    if (node.latencyMs !== undefined) {
      score += Math.max(0, 10 - node.latencyMs / 10);
    } else {
      score += 5;
    }

    // Preferred node ID boost (+50)
    if (prefs.preferNodeId && node.id === prefs.preferNodeId) {
      score += 50;
    }

    if (prefs.requiresAndroid && caps.androidAutomation?.emulatorRunning) {
      score += 8;
    }

    return score;
  }
}

export function getWorkerNodeRegistry(): WorkerNodeRegistry {
  return WorkerNodeRegistry.getInstance();
}

// ---------------------------------------------------------------------------
// Node-target resolution (for `spawn_child { node }`)
// ---------------------------------------------------------------------------

const NODE_PLATFORM_ALIASES: Record<string, NodePlatform> = {
  windows: 'win32', win: 'win32', win32: 'win32', pc: 'win32',
  mac: 'darwin', macos: 'darwin', osx: 'darwin', darwin: 'darwin',
  linux: 'linux',
};

/**
 * Resolve a non-exact `node` value (a capability tag) to a connected worker.
 * Supports gpu / browser / browser-mcp / docker, platform aliases
 * (windows/mac/linux), and CLI names (claude/codex/gemini/copilot/cursor).
 * `browser` prefers an automation-ready node but accepts Chrome-installed;
 * `browser-mcp` requires automation to be wired. Prefers the node with the most
 * spare instance capacity. Pure — operates only on the supplied list.
 */
export function matchNodeByCapabilityTag(
  tag: string,
  nodes: WorkerNodeInfo[],
): WorkerNodeInfo | undefined {
  if (nodes.length === 0) return undefined;
  const t = tag.trim().toLowerCase();
  // Prefer the node with the most spare instance slots.
  const ranked = [...nodes].sort(
    (a, b) =>
      (b.capabilities.maxConcurrentInstances - b.activeInstances) -
      (a.capabilities.maxConcurrentInstances - a.activeInstances),
  );
  if (t === 'gpu') return ranked.find((n) => !!n.capabilities.gpuName);
  if (t === 'browser') {
    // Prefer a browser-automation-ready node; fall back to Chrome-installed.
    return ranked.find((n) => n.capabilities.hasBrowserMcp)
      ?? ranked.find((n) => n.capabilities.hasBrowserRuntime);
  }
  if (t === 'browser-mcp') return ranked.find((n) => n.capabilities.hasBrowserMcp);
  if (t === 'android') return ranked.find((n) => isAndroidAutomationReady(n.capabilities));
  if (t === 'android-physical') {
    return ranked.find((n) => n.capabilities.hasAndroidMcp && hasPhysicalAndroidDevice(n.capabilities));
  }
  if (t === 'docker') return ranked.find((n) => n.capabilities.hasDocker);
  const platform = NODE_PLATFORM_ALIASES[t];
  if (platform) return ranked.find((n) => n.capabilities.platform === platform);
  return ranked.find((n) => n.capabilities.supportedClis.some((c) => c.toLowerCase() === t));
}

function normalizeNodeLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['\u2018\u2019]s\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function hasPhysicalAndroidDevice(caps: WorkerNodeCapabilities): boolean {
  return caps.androidAutomation?.connectedDevices.some((device) =>
    (device.kind === 'usb' || device.kind === 'wifi') && device.state === 'device'
  ) ?? false;
}

export function isAndroidAutomationReady(caps: WorkerNodeCapabilities): boolean {
  if (!caps.hasAndroidMcp) {
    return false;
  }
  const summary = caps.androidAutomation;
  if (!summary) {
    return true;
  }
  return (
    summary.connectedDevices.some((device) => device.state === 'device') ||
    summary.emulatorRunning ||
    summary.avds.length > 0 ||
    Boolean(summary.defaultAvd)
  );
}

/**
 * Resolve a requested `node` (id, name, or capability tag) against the list of
 * currently-connected workers. Returns the resolved node id, or an actionable
 * error message listing what is available. Pure — does not touch the registry
 * singleton, so it is trivially testable.
 *
 * Resolution order: exact id → exact name (case-insensitive) → normalized
 * id/name (e.g. "Noah's laptop" → "noahlaptop") → capability tag.
 */
export function resolveWorkerNodeTarget(
  requested: string,
  connected: WorkerNodeInfo[],
): { nodeId: string } | { error: string } {
  const want = requested.trim();
  // 1. Exact match on node id or name (case-insensitive).
  const exact = connected.find((n) => {
    if (n.id === want) return true;
    return typeof n.name === 'string' && n.name.toLowerCase() === want.toLowerCase();
  });
  if (exact) return { nodeId: exact.id };

  const normalizedWant = normalizeNodeLookup(want);
  const normalized = connected.find((n) =>
    normalizeNodeLookup(n.id) === normalizedWant ||
    (typeof n.name === 'string' && normalizeNodeLookup(n.name) === normalizedWant)
  );
  if (normalized) return { nodeId: normalized.id };

  // 3. Capability-tag fallback.
  const byCapability = matchNodeByCapabilityTag(want, connected);
  if (byCapability) return { nodeId: byCapability.id };
  // 3. No match — clear, actionable error.
  const available = connected.map((n) => n.name || n.id);
  return {
    error: available.length > 0
      ? `No connected worker node matching "${requested}". Available workers: ${available.join(', ')}. You can also target a capability: gpu, browser, android, android-physical, docker, or a platform (windows/mac/linux).`
      : `Cannot run child on "${requested}": no worker nodes are currently connected.`,
  };
}
