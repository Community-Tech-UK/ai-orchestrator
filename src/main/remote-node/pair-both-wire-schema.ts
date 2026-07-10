import { z } from 'zod';
import type {
  PairBothEncryptedPayload,
  PairBothHello,
} from '../../shared/types/pair-both.types';
import { PAIR_BOTH_PROTOCOL_VERSION } from './pair-both-crypto';

const sessionIdSchema = z.string().uuid();
const boundedBase64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const PairBothHelloBaseSchema = z.object({
  protocolVersion: z.literal(PAIR_BOTH_PROTOCOL_VERSION),
  machineName: z.string().trim().min(1).max(255),
  nonce: boundedBase64UrlSchema.min(16).max(128),
  publicKey: boundedBase64UrlSchema.length(59),
  pairingSessionId: sessionIdSchema,
}).strict();
const PairBothWorkerHelloSchema = PairBothHelloBaseSchema.extend({
  role: z.literal('worker'),
}).strict();
const PairBothCoordinatorHelloSchema = PairBothHelloBaseSchema.extend({
  role: z.literal('coordinator'),
}).strict();
const PairBothEncryptedPayloadSchema = z.object({
  algorithm: z.literal('aes-256-gcm'),
  iv: boundedBase64UrlSchema.length(16),
  ciphertext: boundedBase64UrlSchema.min(1).max(64 * 1024),
  authTag: boundedBase64UrlSchema.length(22),
}).strict();

const PairBothWireMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('worker.hello'),
    hello: PairBothWorkerHelloSchema,
  }).strict(),
  z.object({
    type: z.literal('coordinator.hello'),
    hello: PairBothCoordinatorHelloSchema,
    shortCode: z.string().regex(/^\d{3} \d{3}$/),
  }).strict(),
  z.object({ type: z.literal('worker.confirmed'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('worker.confirmed.ack'), sessionId: sessionIdSchema }).strict(),
  z.object({
    type: z.literal('pairing.payload'),
    sessionId: sessionIdSchema,
    encryptedPayload: PairBothEncryptedPayloadSchema,
  }).strict(),
  z.object({ type: z.literal('pairing.payload.ack'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('error'), message: z.string().min(1).max(1_000) }).strict(),
]);

export type PairBothWireMessage =
  | { type: 'worker.hello'; hello: PairBothHello }
  | { type: 'coordinator.hello'; hello: PairBothHello; shortCode: string }
  | { type: 'worker.confirmed'; sessionId: string }
  | { type: 'worker.confirmed.ack'; sessionId: string }
  | { type: 'pairing.payload'; sessionId: string; encryptedPayload: PairBothEncryptedPayload }
  | { type: 'pairing.payload.ack'; sessionId: string }
  | { type: 'error'; message: string };

export function parsePairBothWireMessage(
  data: Buffer | ArrayBuffer | Buffer[],
): PairBothWireMessage {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    throw new Error('Invalid pair-both wire message: expected JSON');
  }
  const parsed = PairBothWireMessageSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Invalid pair-both wire message: schema validation failed');
  }
  return parsed.data as PairBothWireMessage;
}
