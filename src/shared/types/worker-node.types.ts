import type { CanonicalCliType } from './settings.types';
import type { DiscoveredProject } from './remote-fs.types';

export type NodePlatform = 'darwin' | 'win32' | 'linux';

export interface WorkerLoadedModel {
  id: string;
  /** Context window the model is *currently loaded* with (tokens). */
  contextLength: number;
}

export interface WorkerLocalModelCapability {
  provider: 'ollama' | 'openai-compatible';
  baseUrl: string;
  /** All models the server advertises (downloaded/available), loaded or not. */
  models: string[];
  /**
   * Models currently resident in memory, with their loaded context length. Lets
   * the coordinator's auto-pick prefer a model that's already loaded with an
   * adequate context window instead of JIT-loading a larger one at a tiny
   * default context (which would overflow on big inputs). Optional — absent when
   * the server doesn't expose load state.
   */
  loadedModels?: WorkerLoadedModel[];
  healthy: boolean;
}

/**
 * Non-secret summary of a node's browser-automation configuration, surfaced in
 * capabilities so the coordinator UI can reflect current settings. Deliberately
 * excludes anything sensitive (no tokens; the profile is the operator's own).
 */
export interface WorkerNodeBrowserAutomationSummary {
  enabled: boolean;
  headless: boolean;
  /** Resolved automation profile directory (operator-owned path). */
  profileDir: string;
  /**
   * Whether the managed Chrome is actually up right now. Enablement is lazy —
   * Chrome only launches on the first browser-enabled spawn — so an enabled node
   * is typically `running: false` until first use. The UI distinguishes
   * "enabled (starts on first use)" from "ready (Chrome verified up)".
   */
  running: boolean;
}

export interface WorkerNodeCapabilities {
  platform: NodePlatform;
  arch: string;
  cpuCores: number;
  totalMemoryMB: number;
  availableMemoryMB: number;
  gpuName?: string;
  gpuMemoryMB?: number;
  supportedClis: CanonicalCliType[];
  hasBrowserRuntime: boolean;
  hasBrowserMcp: boolean;
  /** Present when the node reports browser-automation config (newer workers). */
  browserAutomation?: WorkerNodeBrowserAutomationSummary;
  hasDocker: boolean;
  maxConcurrentInstances: number;
  workingDirectories: string[];
  browsableRoots: string[];
  discoveredProjects: DiscoveredProject[];
  localModelEndpoints?: WorkerLocalModelCapability[];
}

export interface WorkerNodeInfo {
  id: string;
  name: string;
  address: string;
  capabilities: WorkerNodeCapabilities;
  status: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  connectedAt?: number;
  lastHeartbeat?: number;
  activeInstances: number;
  latencyMs?: number;
}

export type ExecutionLocation =
  | { type: 'local' }
  | { type: 'remote'; nodeId: string };

export interface NodePlacementPrefs {
  requiresBrowser?: boolean;
  requiresGpu?: boolean;
  preferPlatform?: NodePlatform;
  preferNodeId?: string;
  requiresCli?: CanonicalCliType;
  requiresWorkingDirectory?: string;
}

export interface NodeIdentity {
  sessionId: string;
  nodeId: string;
  nodeName: string;
  /** Transport token used for coordinator<->node RPC after registration. */
  transportToken: string;
  /** Backward-compatible alias for transportToken. */
  token: string;
  /** Same-node recovery token used to rotate a stale transport token. */
  recoveryToken?: string;
  issuedAt: number;
  /** Backward-compatible alias for issuedAt. */
  createdAt: number;
  lastSeenAt: number;
  authMethod: 'pairing_credential' | 'manual_pairing';
  pairingLabel?: string;
}

export interface RemotePairingCredentialInfo {
  token: string;
  createdAt: number;
  expiresAt: number;
  label?: string;
}
