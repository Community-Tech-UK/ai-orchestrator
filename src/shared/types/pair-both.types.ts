export type HarnessRole = 'unset' | 'coordinator' | 'worker';

export interface WorkerModeSettings {
  role: HarnessRole;
  startWorkerOnLaunch: boolean;
  installWorkerService: boolean;
  /**
   * Open Harness when the user signs in (Windows/macOS login item), so the
   * "run while Harness is open" worker comes back after a reboot. Only applied
   * while the role is 'worker'.
   */
  openAtLogin?: boolean;
  /**
   * Windows: a per-user scheduled task runs the worker from sign-in, even with
   * Harness closed, instead of Harness starting it.
   */
  runAtSignIn?: boolean;
  lastCoordinatorName?: string;
  lastCoordinatorUrl?: string;
}

/** Non-secret view of the paired worker config, safe to hand to the renderer. */
export interface WorkerModeConfigSummary {
  nodeId: string;
  name: string;
  coordinatorUrl?: string;
  namespace: string;
  maxConcurrentInstances: number;
  workingDirectories: string[];
}

export interface WorkerModeRuntimeSnapshot {
  state: 'running' | 'stopped' | 'service-installed';
  pid?: number;
  command?: string;
  error?: string;
}

/**
 * What the Worker Mode page needs to rebuild itself after a relaunch or
 * navigation: whether this computer holds a pairing, whether the main Harness
 * has accepted it yet, and what the in-app worker process is doing.
 */
export interface WorkerModeStatus {
  /** A coordinator address and a credential are saved on this computer. */
  paired: boolean;
  /**
   * The main Harness accepted this computer at least once and issued it a
   * long-lived node credential. A paired-but-not-enrolled worker is still
   * holding the one-time pairing pass.
   */
  enrolled: boolean;
  config: WorkerModeConfigSummary | null;
  runtime: WorkerModeRuntimeSnapshot;
  /** The OS background service, not Harness, owns the worker process. */
  backgroundService: boolean;
  /**
   * The Windows sign-in task owns the worker; `runtime` then reports whether
   * that worker is alive (from its single-instance lock), not a Harness child.
   */
  runAtSignIn: boolean;
  /** This computer can run the worker independently of Harness (Windows). */
  runAtSignInAvailable: boolean;
}

export type PairBothRole = 'coordinator' | 'worker';

export interface PairBothHello {
  protocolVersion: string;
  role: PairBothRole;
  machineName: string;
  nonce: string;
  publicKey: string;
  pairingSessionId: string;
}

export interface PairBothTranscript {
  protocolVersion: string;
  pairingSessionId: string;
  coordinator: PairBothHello;
  worker: PairBothHello;
}

export interface PairBothDiscoveryMetadata {
  product: 'Harness';
  protocol: 'aio-worker-pair-v1';
  protocolVersion: string;
  pairingSessionId: string;
  friendlyName: string;
  namespace: string;
  port: number;
  coordinatorPublicKey: string;
  expiresAt: number;
}

export interface PairBothCandidate extends PairBothDiscoveryMetadata {
  id: string;
  host: string;
  addresses: string[];
}

export interface PairBothEncryptedPayload {
  algorithm: 'aes-256-gcm';
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface PairBothConnectionConfig {
  name?: string;
  authToken: string;
  coordinatorUrl: string;
  /**
   * Optional ordered fallback coordinator URLs, tried when `coordinatorUrl` is
   * unreachable. Consumed end-to-end by the worker (`WorkerConfig.coordinatorUrls`,
   * `getConfiguredCoordinatorUrl()`, `worker-agent.ts`) and now honoured by the
   * pair CLI, which previously dropped it silently.
   *
   * NOTE: `buildCanonicalConnectionConfig()` does not emit this yet — doing so
   * requires deciding where the alternates come from (e.g. Tailscale hostname
   * plus LAN IP), which is a product decision, not a plumbing one. Until then
   * this is populated only by hand-written or scripted configs.
   */
  coordinatorUrls?: string[];
  namespace: string;
  maxConcurrentInstances: number;
  workingDirectories: string[];
}

export type PairBothSessionStatus =
  | 'waiting'
  | 'confirming'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'cancelled'
  | 'expired';

export interface PairBothSessionState {
  sessionId: string;
  status: PairBothSessionStatus;
  protocolVersion: string;
  machineName: string;
  namespace: string;
  listenerPort: number;
  coordinatorUrl: string;
  expiresAt: number;
  coordinatorHello: PairBothHello;
  workerHello?: PairBothHello;
  shortCode?: string;
  workerConfirmed: boolean;
  coordinatorApproved: boolean;
  payloadDelivered: boolean;
  error?: string;
}

export interface PairBothPayloadResult {
  sessionId: string;
  connectionConfig: PairBothConnectionConfig;
  encryptedPayload?: PairBothEncryptedPayload;
}
