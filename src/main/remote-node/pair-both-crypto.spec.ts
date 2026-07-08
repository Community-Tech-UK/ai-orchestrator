import { describe, expect, it } from 'vitest';
import {
  buildPairBothTranscript,
  computePairBothShortCode,
  decryptPairBothPayload,
  derivePairBothSessionKey,
  derivePairBothSharedSecret,
  encryptPairBothPayload,
  generatePairBothKeyMaterial,
  hashPairBothTranscript,
} from './pair-both-crypto';
import type { PairBothHello, PairBothTranscript } from '../../shared/types/pair-both.types';

function hello(
  role: PairBothHello['role'],
  publicKey: string,
  patch: Partial<PairBothHello> = {},
): PairBothHello {
  return {
    protocolVersion: '1',
    role,
    machineName: role === 'coordinator' ? 'James MacBook' : 'Noah PC',
    nonce: role === 'coordinator' ? 'coordinator-nonce' : 'worker-nonce',
    publicKey,
    pairingSessionId: 'session-1',
    ...patch,
  };
}

function transcript(
  coordinator: PairBothHello,
  worker: PairBothHello,
  patch: Partial<PairBothTranscript> = {},
): PairBothTranscript {
  return buildPairBothTranscript({
    protocolVersion: '1',
    pairingSessionId: 'session-1',
    coordinator,
    worker,
    ...patch,
  });
}

describe('pair-both crypto', () => {
  it('derives the same short authentication string on both sides', () => {
    const coordinatorKeys = generatePairBothKeyMaterial();
    const workerKeys = generatePairBothKeyMaterial();
    const coordinatorHello = hello('coordinator', coordinatorKeys.publicKey);
    const workerHello = hello('worker', workerKeys.publicKey);
    const currentTranscript = transcript(coordinatorHello, workerHello);
    const transcriptHash = hashPairBothTranscript(currentTranscript);

    const coordinatorSecret = derivePairBothSharedSecret(
      coordinatorKeys.privateKey,
      workerHello.publicKey,
    );
    const workerSecret = derivePairBothSharedSecret(
      workerKeys.privateKey,
      coordinatorHello.publicKey,
    );

    expect(computePairBothShortCode(coordinatorSecret, transcriptHash)).toBe(
      computePairBothShortCode(workerSecret, transcriptHash),
    );
  });

  it('changes the short authentication string when either public key changes', () => {
    const coordinatorKeys = generatePairBothKeyMaterial();
    const workerKeys = generatePairBothKeyMaterial();
    const substitutedWorkerKeys = generatePairBothKeyMaterial();
    const coordinatorHello = hello('coordinator', coordinatorKeys.publicKey);
    const workerHello = hello('worker', workerKeys.publicKey);
    const substitutedWorkerHello = hello('worker', substitutedWorkerKeys.publicKey);

    const originalHash = hashPairBothTranscript(transcript(coordinatorHello, workerHello));
    const substitutedHash = hashPairBothTranscript(transcript(coordinatorHello, substitutedWorkerHello));

    const originalSecret = derivePairBothSharedSecret(
      coordinatorKeys.privateKey,
      workerHello.publicKey,
    );
    const substitutedSecret = derivePairBothSharedSecret(
      coordinatorKeys.privateKey,
      substitutedWorkerHello.publicKey,
    );

    expect(computePairBothShortCode(originalSecret, originalHash)).not.toBe(
      computePairBothShortCode(substitutedSecret, substitutedHash),
    );
  });

  it('binds roles, names, nonces, protocol version, and session id into the transcript hash', () => {
    const coordinatorKeys = generatePairBothKeyMaterial();
    const workerKeys = generatePairBothKeyMaterial();
    const coordinatorHello = hello('coordinator', coordinatorKeys.publicKey);
    const workerHello = hello('worker', workerKeys.publicKey);
    const base = transcript(coordinatorHello, workerHello);
    const baseHash = hashPairBothTranscript(base).toString('hex');

    const variants: PairBothTranscript[] = [
      transcript({ ...coordinatorHello, role: 'worker' }, workerHello),
      transcript({ ...coordinatorHello, machineName: 'Other Mac' }, workerHello),
      transcript({ ...coordinatorHello, nonce: 'other-coordinator-nonce' }, workerHello),
      transcript(coordinatorHello, { ...workerHello, role: 'coordinator' }),
      transcript(coordinatorHello, { ...workerHello, machineName: 'Other PC' }),
      transcript(coordinatorHello, { ...workerHello, nonce: 'other-worker-nonce' }),
      transcript(
        { ...coordinatorHello, protocolVersion: '2' },
        { ...workerHello, protocolVersion: '2' },
        { protocolVersion: '2' },
      ),
      transcript(
        { ...coordinatorHello, pairingSessionId: 'session-2' },
        { ...workerHello, pairingSessionId: 'session-2' },
        { pairingSessionId: 'session-2' },
      ),
    ];

    for (const variant of variants) {
      expect(hashPairBothTranscript(variant).toString('hex')).not.toBe(baseHash);
    }
  });

  it('encrypts and authenticates the pairing payload with transcript-bound key material', () => {
    const coordinatorKeys = generatePairBothKeyMaterial();
    const workerKeys = generatePairBothKeyMaterial();
    const currentTranscript = transcript(
      hello('coordinator', coordinatorKeys.publicKey),
      hello('worker', workerKeys.publicKey),
    );
    const transcriptHash = hashPairBothTranscript(currentTranscript);
    const secret = derivePairBothSharedSecret(coordinatorKeys.privateKey, workerKeys.publicKey);
    const key = derivePairBothSessionKey(secret, transcriptHash);

    const encrypted = encryptPairBothPayload(
      { authToken: 'one-time-token', coordinatorUrl: 'ws://192.168.1.2:4878' },
      key,
      transcriptHash,
    );

    expect(decryptPairBothPayload(encrypted, key, transcriptHash)).toEqual({
      authToken: 'one-time-token',
      coordinatorUrl: 'ws://192.168.1.2:4878',
    });

    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` };
    expect(() => decryptPairBothPayload(tampered, key, transcriptHash)).toThrow();
  });
});
