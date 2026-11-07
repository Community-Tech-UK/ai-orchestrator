import type { RemotePairingCredential } from '../auth/remote-auth';
import type { PairBothCandidate, PairBothHello } from '../../shared/types/pair-both.types';

export const PAIR_BOTH_WS_MAX_PAYLOAD_BYTES = 64 * 1024;
export const PAIR_BOTH_CONFIRM_TIMEOUT_MS = 15_000;
export const PAIR_BOTH_WORKER_HANDSHAKE_TIMEOUT_MS = 15_000;
export const PAIR_BOTH_WORKER_RESULT_TIMEOUT_MS = 5 * 60_000;
/** How long the joining side waits for one address before trying the next. */
export const PAIR_BOTH_ADDRESS_TIMEOUT_MS = 3_000;
/** Mirrors the candidate schema's limit on `addresses`. */
export const MAX_CANDIDATE_ADDRESSES = 16;

export interface PairBothAuthPort {
  issuePairingCredential(options: { label?: string; ttlMs?: number }): RemotePairingCredential;
  revokePairingCredential?(token: string): boolean;
}

export interface PairBothRendezvousServiceOptions {
  auth: PairBothAuthPort;
  machineName?: string;
  workerConfigPath?: string;
  /** Runs before a newly delivered pairing overwrites the worker config. */
  beforeWorkerConfigWrite?: () => Promise<unknown> | unknown;
  now?: () => number;
  workerHandshakeTimeoutMs?: number;
  workerResultTimeoutMs?: number;
  addressTimeoutMs?: number;
}

export interface StartCoordinatorPairingInput {
  host: string;
  namespace: string;
  coordinatorUrl: string;
  /** Other coordinator URLs the worker may use, tried after `coordinatorUrl`. */
  coordinatorUrls?: string[];
  ttlMs?: number;
}

export interface PairBothWorkerPairingState {
  sessionId: string;
  status: 'confirming';
  shortCode: string;
  candidate: PairBothCandidate;
  coordinatorHello: PairBothHello;
  workerHello: PairBothHello;
}
