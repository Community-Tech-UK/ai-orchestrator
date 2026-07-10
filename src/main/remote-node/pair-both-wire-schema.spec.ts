import { describe, expect, it } from 'vitest';
import { generatePairBothKeyMaterial, PAIR_BOTH_PROTOCOL_VERSION } from './pair-both-crypto';
import { parsePairBothWireMessage } from './pair-both-wire-schema';

describe('parsePairBothWireMessage', () => {
  it('accepts a strict worker hello with bounded protocol fields', () => {
    const publicKey = generatePairBothKeyMaterial().publicKey;
    const message = parsePairBothWireMessage(Buffer.from(JSON.stringify({
      type: 'worker.hello',
      hello: {
        protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
        role: 'worker',
        machineName: 'Worker PC',
        nonce: 'worker_nonce_123',
        publicKey,
        pairingSessionId: '4cb9aa33-d0e4-4e1e-b986-5a974fca6ca9',
      },
    })));

    expect(message).toMatchObject({ type: 'worker.hello' });
  });

  it.each([
    { type: 'unknown' },
    { type: 'worker.hello', hello: {} },
    {
      type: 'worker.hello',
      hello: {
        protocolVersion: PAIR_BOTH_PROTOCOL_VERSION,
        role: 'worker',
        machineName: 'Worker PC',
        nonce: 'worker_nonce_123',
        publicKey: 'not-a-valid-x25519-key',
        pairingSessionId: '4cb9aa33-d0e4-4e1e-b986-5a974fca6ca9',
      },
    },
    {
      type: 'worker.confirmed',
      sessionId: '4cb9aa33-d0e4-4e1e-b986-5a974fca6ca9',
      unexpected: true,
    },
  ])('rejects malformed or unknown wire messages: %o', (message) => {
    expect(() => parsePairBothWireMessage(Buffer.from(JSON.stringify(message)))).toThrow(
      /Invalid pair-both wire message/,
    );
  });
});
