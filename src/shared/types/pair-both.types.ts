export type HarnessRole = 'unset' | 'coordinator' | 'worker';

export interface WorkerModeSettings {
  role: HarnessRole;
  startWorkerOnLaunch: boolean;
  installWorkerService: boolean;
  lastCoordinatorName?: string;
  lastCoordinatorUrl?: string;
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
