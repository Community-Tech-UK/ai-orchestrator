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
 * Where the worker process says it is with the main Harness:
 * - `connecting`: started, looking for the main Harness for the first time.
 * - `registering`: reached it and is waiting for it to accept this computer.
 * - `connected`: the main Harness accepted this computer and can send it work.
 * - `reconnecting`: was connected, lost the connection, trying again.
 * - `unreachable`: none of the main Harness's addresses answered; still trying.
 * - `rejected`: the main Harness refused this computer's credential.
 * - `stopped`: the worker shut down on purpose.
 * - `failed`: the worker could not start at all (`message` says why).
 */
export type WorkerConnectionState =
  | 'connecting'
  | 'registering'
  | 'connected'
  | 'reconnecting'
  | 'unreachable'
  | 'rejected'
  | 'stopped'
  | 'failed';

/**
 * The `unreachable` reason a worker gives when the fault was on its own side
 * (an internal error while connecting), not the network or the main Harness.
 */
export const WORKER_INTERNAL_CONNECT_ERROR = 'Something went wrong on this computer while connecting.';

/** The worker's own report of its connection, as the Worker Mode page sees it. */
export interface WorkerConnectionSnapshot {
  state: WorkerConnectionState;
  /** The main Harness address being tried, or the one it is connected to. */
  coordinatorUrl?: string;
  /** Short reason for `rejected`, `unreachable` and `failed`. Never holds a credential. */
  message?: string;
  /** When the current state began. */
  since: number;
  /** When the worker last wrote its report. */
  updatedAt: number;
  /** The process that wrote the report is still running. */
  alive: boolean;
  /** A live worker that has not refreshed its report for a while (it may be stuck). */
  stale: boolean;
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
  /**
   * The worker's own report of whether it reached the main Harness. Null when
   * no worker for this pairing has reported yet.
   */
  connection: WorkerConnectionSnapshot | null;
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
