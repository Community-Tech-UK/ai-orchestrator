import * as crypto from 'node:crypto';
import type {
  PairBothEncryptedPayload,
  PairBothHello,
  PairBothTranscript,
} from '../../shared/types/pair-both.types';

export const PAIR_BOTH_PROTOCOL = 'aio-worker-pair-v1';
export const PAIR_BOTH_PROTOCOL_VERSION = '1';

export interface PairBothKeyMaterial {
  privateKey: crypto.KeyObject;
  publicKey: string;
}

export function generatePairBothKeyMaterial(): PairBothKeyMaterial {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey,
    publicKey: exportPairBothPublicKey(publicKey),
  };
}

export function createPairBothNonce(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function exportPairBothPublicKey(publicKey: crypto.KeyObject): string {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
}

export function derivePairBothSharedSecret(
  privateKey: crypto.KeyObject,
  peerPublicKey: string,
): Buffer {
  return crypto.diffieHellman({
    privateKey,
    publicKey: crypto.createPublicKey({
      key: Buffer.from(peerPublicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    }),
  });
}

export function buildPairBothTranscript(input: PairBothTranscript): PairBothTranscript {
  return {
    protocolVersion: input.protocolVersion,
    pairingSessionId: input.pairingSessionId,
    coordinator: normalizeHello(input.coordinator),
    worker: normalizeHello(input.worker),
  };
}

export function hashPairBothTranscript(transcript: PairBothTranscript): Buffer {
  return crypto
    .createHash('sha256')
    .update(PAIR_BOTH_PROTOCOL)
    .update('\0')
    .update(canonicalJson(buildPairBothTranscript(transcript)))
    .digest();
}

export function derivePairBothSessionKey(
  sharedSecret: Buffer,
  transcriptHash: Buffer,
): Buffer {
  return hkdf(sharedSecret, transcriptHash, `${PAIR_BOTH_PROTOCOL}:payload-key`, 32);
}

export function computePairBothShortCode(
  sharedSecret: Buffer,
  transcriptHash: Buffer,
): string {
  const material = hkdf(sharedSecret, transcriptHash, `${PAIR_BOTH_PROTOCOL}:short-auth-string`, 8);
  const value = material.readUInt32BE(0) % 1_000_000;
  const digits = value.toString().padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function encryptPairBothPayload(
  payload: unknown,
  sessionKey: Buffer,
  transcriptHash: Buffer,
): PairBothEncryptedPayload {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
  cipher.setAAD(transcriptHash);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptPairBothPayload(
  payload: PairBothEncryptedPayload,
  sessionKey: Buffer,
  transcriptHash: Buffer,
): unknown {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    sessionKey,
    Buffer.from(payload.iv, 'base64url'),
  );
  decipher.setAAD(transcriptHash);
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as unknown;
}

export function derivePairBothCodeForHellos(params: {
  privateKey: crypto.KeyObject;
  peerPublicKey: string;
  transcript: PairBothTranscript;
}): string {
  const transcriptHash = hashPairBothTranscript(params.transcript);
  const sharedSecret = derivePairBothSharedSecret(params.privateKey, params.peerPublicKey);
  return computePairBothShortCode(sharedSecret, transcriptHash);
}

export function derivePairBothPayloadKeyForHellos(params: {
  privateKey: crypto.KeyObject;
  peerPublicKey: string;
  transcript: PairBothTranscript;
}): Buffer {
  const transcriptHash = hashPairBothTranscript(params.transcript);
  const sharedSecret = derivePairBothSharedSecret(params.privateKey, params.peerPublicKey);
  return derivePairBothSessionKey(sharedSecret, transcriptHash);
}

function hkdf(
  sharedSecret: Buffer,
  transcriptHash: Buffer,
  info: string,
  length: number,
): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    sharedSecret,
    transcriptHash,
    Buffer.from(info, 'utf8'),
    length,
  ));
}

function normalizeHello(hello: PairBothHello): PairBothHello {
  return {
    protocolVersion: hello.protocolVersion,
    role: hello.role,
    machineName: hello.machineName,
    nonce: hello.nonce,
    publicKey: hello.publicKey,
    pairingSessionId: hello.pairingSessionId,
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortCanonical(entry)]),
  );
}
