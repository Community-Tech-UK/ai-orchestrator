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
