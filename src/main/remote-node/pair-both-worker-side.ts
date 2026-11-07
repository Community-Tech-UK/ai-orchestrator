import type { WebSocket } from 'ws';
import { getLogger } from '../logging/logger';
import {
  buildPairBothTranscript,
  decryptPairBothPayload,
  derivePairBothCodeForHellos,
  derivePairBothPayloadKeyForHellos,
  hashPairBothTranscript,
  type PairBothKeyMaterial,
} from './pair-both-crypto';
import { capForLog, openFirstReachableSocket } from './pair-both-rendezvous-helpers';
import type { PairBothWireMessage } from './pair-both-wire-schema';
import { parsePairingConfigInput, type ParsedPairingConfig } from '../../worker-agent/cli/pairing-config';
import type {
  PairBothCandidate,
  PairBothEncryptedPayload,
  PairBothHello,
  PairBothTranscript,
} from '../../shared/types/pair-both.types';

const logger = getLogger('PairBoth');

/**
 * The joining side's first step: dial the offering computer on each of its
 * addresses in order and return the first socket that opens. Logs the addresses
 * tried, never anything from the handshake itself.
 */
export async function dialPairBothCandidate(
  candidate: PairBothCandidate,
  options: { maxPayload: number; perAddressTimeoutMs: number; now: () => number },
): Promise<WebSocket> {
  const addresses = [...new Set([candidate.host, ...candidate.addresses])];
  const sessionId = candidate.pairingSessionId;
  logger.info('Pair-both joining a coordinator', {
    sessionId,
    namespace: candidate.namespace,
    coordinator: capForLog(candidate.friendlyName),
    port: candidate.port,
    addresses,
    expiresAt: new Date(candidate.expiresAt).toISOString(),
  });
  try {
    const { socket, address } = await openFirstReachableSocket({
      addresses,
      port: candidate.port,
      maxPayload: options.maxPayload,
      perAddressTimeoutMs: options.perAddressTimeoutMs,
      shouldContinue: () => options.now() < candidate.expiresAt,
      onAttemptFailed: (failed, reason) => {
        logger.info('Pair-both address did not answer', { sessionId, address: failed, reason: capForLog(reason) });
      },
    });
    logger.info('Pair-both reached the coordinator', { sessionId, address });
    return socket;
  } catch (error) {
    logger.warn('Pair-both could not reach the coordinator', {
      sessionId,
      error: capForLog(error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
}

/** Checks the coordinator's hello against the offer and the code both sides must show. */
export function verifyCoordinatorHello(
  candidate: PairBothCandidate,
  message: Extract<PairBothWireMessage, { type: 'coordinator.hello' }>,
  workerHello: PairBothHello,
  keyMaterial: PairBothKeyMaterial,
): { transcript: PairBothTranscript; shortCode: string } {
  if (message.hello.pairingSessionId !== candidate.pairingSessionId) {
    throw new Error('Coordinator hello does not match the selected pairing session');
  }
  if (message.hello.publicKey !== candidate.coordinatorPublicKey) {
    throw new Error('Coordinator public key does not match discovery metadata');
  }
  if (message.hello.protocolVersion !== candidate.protocolVersion) {
    throw new Error('Coordinator protocol version does not match discovery metadata');
  }
  const transcript = buildPairBothTranscript({
    protocolVersion: message.hello.protocolVersion,
    pairingSessionId: candidate.pairingSessionId,
    coordinator: message.hello,
    worker: workerHello,
  });
  const shortCode = derivePairBothCodeForHellos({
    privateKey: keyMaterial.privateKey,
    peerPublicKey: message.hello.publicKey,
    transcript,
  });
  if (shortCode !== message.shortCode) {
    throw new Error('Pair-both verification code mismatch');
  }
  return { transcript, shortCode };
}

/** Decrypts the coordinator's payload and reads it as a pairing config. */
export function decryptPairingPayload(
  payload: PairBothEncryptedPayload,
  keyMaterial: PairBothKeyMaterial,
  transcript: PairBothTranscript,
): ParsedPairingConfig {
  const sessionKey = derivePairBothPayloadKeyForHellos({
    privateKey: keyMaterial.privateKey,
    peerPublicKey: transcript.coordinator.publicKey,
    transcript,
  });
  const decrypted = decryptPairBothPayload(payload, sessionKey, hashPairBothTranscript(transcript));
  return parsePairingConfigInput(JSON.stringify(decrypted));
}
