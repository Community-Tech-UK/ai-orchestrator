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
  /** Stable non-secret endpoint identity scoped to the provider on this worker. */
  endpointId?: string;
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

export interface WorkerLocalSttCapability {
  provider: 'openai-compatible' | 'whisper-cli';
  baseUrl: string;
  models: string[];
  healthy: boolean;
}

/**
 * Non-secret identity of the worker-agent process currently reporting
 * heartbeats. Used as rollout evidence: a browser-capable node must advertise
 * the rebuilt worker version and a fresh process start before release readiness
 * can be considered proven.
 */
export interface WorkerAgentBuildSummary {
  version: string;
  startedAt: number;
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

/**
 * Non-secret state for the worker-local Chrome extension relay. The relay lets
 * a Chrome extension on the worker machine share existing tabs with the
 * coordinator-governed Browser Gateway.
 */
export interface WorkerNodeExtensionRelaySummary {
  enabled: boolean;
  running: boolean;
  socketPath?: string;
  registration?: 'ok' | 'repaired' | 'contested' | 'error';
  lastRegistrationCheckAt?: number;
  manifestPath?: string;
  registrationError?: string;
  extensionVersion?: string;
  extensionReloadedAt?: number;
  lastExtensionContactAt?: number;
}

export interface AndroidDeviceInfo {
  serial: string;
  kind: 'emulator' | 'usb' | 'wifi';
  model?: string;
  apiLevel?: number;
  state: 'device' | 'offline' | 'unauthorized';
}

/**
 * Non-secret Android automation state for a worker node. SDK paths and AVD
 * names are operator-owned machine details but not credentials; never include
 * adb auth material, emulator console tokens, or app data here.
 */
export interface WorkerNodeAndroidAutomationSummary {
  enabled: boolean;
  sdkPath: string;
  adbVersion?: string;
  avds: string[];
  connectedDevices: AndroidDeviceInfo[];
  emulatorRunning: boolean;
  hasMaestro: boolean;
  defaultAvd?: string;
  headlessEmulator?: boolean;
  maxEmulators?: number;
  bootTimeoutMs?: number;
  allowPhysicalDevices?: boolean;
  injectMaestroMcp?: boolean;
  appiumMcp?: boolean;
  mobileMcpVersion?: string;
}

export interface WorkerNodeFileTransferRoot {
  id: string;
  label: string;
  path: string;
  read: boolean;
  write: boolean;
  approvalRequired?: boolean;
}

export interface WorkerNodeFileTransferSummary {
  enabled: boolean;
  maxFileBytes: number;
  roots: WorkerNodeFileTransferRoot[];
}

export interface WorkerNodeCapabilities {
  workerAgent?: WorkerAgentBuildSummary;
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
  hasExtensionRelay?: boolean;
  extensionRelay?: WorkerNodeExtensionRelaySummary;
  hasAndroidMcp: boolean;
  /** Present when the node can inspect Android SDK/device state (newer workers). */
  androidAutomation?: WorkerNodeAndroidAutomationSummary;
  hasDocker: boolean;
  maxConcurrentInstances: number;
  workingDirectories: string[];
  browsableRoots: string[];
  fileTransfer?: WorkerNodeFileTransferSummary;
  discoveredProjects: DiscoveredProject[];
  localModelEndpoints?: WorkerLocalModelCapability[];
  localSttEndpoints?: WorkerLocalSttCapability[];
}

export interface WorkerNodeInfo {
  id: string;
  name: string;
  address?: string;
  capabilities: WorkerNodeCapabilities;
  status: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  connectedAt?: number;
  lastHeartbeat?: number;
  activeInstances: number;
  latencyMs?: number;
}

export interface RemoteNodeRosterEntry {
  id: string;
  name: string;
  status: WorkerNodeInfo['status'];
  platform?: NodePlatform;
  arch?: string;
  address: string;
  connected: boolean;
  connectedAt?: number;
  lastHeartbeat?: number;
  lastAuthenticatedAt?: number;
  registeredAt?: number;
  pairingLabel?: string;
  authMethod?: 'pairing_credential' | 'manual_pairing';
  supportedClis: CanonicalCliType[];
  workerAgent?: WorkerAgentBuildSummary;
  hasBrowserRuntime: boolean;
  hasBrowserMcp: boolean;
  browserAutomation?: WorkerNodeBrowserAutomationSummary;
  hasExtensionRelay?: boolean;
  extensionRelay?: WorkerNodeExtensionRelaySummary;
  hasAndroidMcp: boolean;
  androidAutomation?: WorkerNodeAndroidAutomationSummary;
  hasDocker: boolean;
  gpuName?: string;
  gpuMemoryMB?: number;
  activeInstances: number;
  maxConcurrentInstances: number;
  workingDirectories: string[];
  fileTransfer?: WorkerNodeFileTransferSummary;
  latencyMs?: number;
  /**
   * Backward-compatible non-secret capability block for existing renderer
   * helpers. It deliberately excludes all identity/session tokens.
   */
  capabilities: WorkerNodeCapabilities;
}

export type RemoteWorkerRepairStatus =
  | 'healthy'
  | 'depaired'
  | 'unreachable'
  | 'unknown';

export interface RemoteWorkerRejectedRegistration {
  nodeId: string;
  nodeName?: string;
  platformHint?: NodePlatform;
  reason: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
}

export interface RemoteWorkerRepairDiagnostic {
  nodeId: string;
  nodeName: string;
  status: RemoteWorkerRepairStatus;
  liveStatus?: WorkerNodeInfo['status'];
  trustedPlatform?: NodePlatform;
  platformHint?: NodePlatform;
  lastSeenAt?: number;
  lastHeartbeat?: number;
  lastRejectedRegistration?: RemoteWorkerRejectedRegistration;
  coordinatorUrls: string[];
  hasCoordinatorRecoveryToken: boolean;
  recommendedAction:
    | 'none'
    | 'copy_windows_command'
    | 'choose_platform'
    | 'check_connectivity'
    | 'configure_tls'
    | 're_pair';
  availableActions: 'check_service_status'[];
  summary: string;
}

export interface RemoteWorkerRepairCommand {
  nodeId: string;
  nodeName: string;
  platform: 'win32';
  expiresAt: number;
  serviceId: string;
  configPath: string;
  primaryCoordinatorUrl: string;
  coordinatorUrls: string[];
  command: string;
  redactedPreview: string;
}

export type ExecutionLocation =
  | { type: 'local' }
  | { type: 'remote'; nodeId: string };

export interface NodePlacementPrefs {
  requiresBrowser?: boolean;
  requiresAndroid?: boolean;
  androidDeviceKind?: 'emulator' | 'physical' | 'any';
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
  /** Trusted platform last reported by an authenticated registration/heartbeat. */
  platform?: NodePlatform;
  platformSeenAt?: number;
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
