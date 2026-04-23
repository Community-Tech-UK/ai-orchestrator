import { describe, it, expect, beforeEach } from 'vitest';
import { generateAuthToken, validateTokenTwoTier, AUTH_TOKEN_LENGTH, ensureEnrollmentToken } from '../auth-validator';
import type { NodeIdentity } from '../../../shared/types/worker-node.types';

describe('auth-validator', () => {
  const enrollmentToken = generateAuthToken();
  let registeredNodes: Record<string, NodeIdentity>;

  beforeEach(() => {
    registeredNodes = {};
    registeredNodes['node-1'] = {
      sessionId: 'session-node-1',
      nodeId: 'node-1',
      nodeName: 'test-node',
      transportToken: generateAuthToken(),
      token: generateAuthToken(),
      issuedAt: Date.now(),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      authMethod: 'pairing_credential',
    };
    registeredNodes['node-1'].token = registeredNodes['node-1'].transportToken;
    registeredNodes['node-1'].createdAt = registeredNodes['node-1'].issuedAt;
  });

  it('rejects empty token', () => {
    expect(validateTokenTwoTier('', enrollmentToken, registeredNodes).type).toBe('rejected');
  });

  it('rejects null/undefined token', () => {
    expect(validateTokenTwoTier(null, enrollmentToken, registeredNodes).type).toBe('rejected');
    expect(validateTokenTwoTier(undefined, enrollmentToken, registeredNodes).type).toBe('rejected');
  });

  it('rejects invalid token', () => {
    expect(validateTokenTwoTier('bad-token', enrollmentToken, registeredNodes).type).toBe('rejected');
  });

  it('identifies registered node token', () => {
    const result = validateTokenTwoTier(registeredNodes['node-1'].token, enrollmentToken, registeredNodes);
    expect(result.type).toBe('registered');
    if (result.type === 'registered') expect(result.nodeId).toBe('node-1');
  });

  it('identifies enrollment token', () => {
    expect(validateTokenTwoTier(enrollmentToken, enrollmentToken, registeredNodes).type).toBe('enrollment');
  });

  it('prioritizes node token over enrollment when they match', () => {
    registeredNodes['node-2'] = {
      sessionId: 'session-node-2',
      nodeId: 'node-2',
      nodeName: 'same-token',
      transportToken: enrollmentToken,
      token: enrollmentToken,
      issuedAt: Date.now(),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      authMethod: 'pairing_credential',
    };
    expect(validateTokenTwoTier(enrollmentToken, enrollmentToken, registeredNodes).type).toBe('registered');
  });

  it('generates tokens of correct length', () => {
    const token = generateAuthToken();
    expect(token.length).toBe(AUTH_TOKEN_LENGTH);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it('ensureEnrollmentToken returns existing if non-empty', () => {
    expect(ensureEnrollmentToken('abc')).toBe('abc');
  });

  it('ensureEnrollmentToken generates new if empty', () => {
    const token = ensureEnrollmentToken('');
    expect(token.length).toBe(AUTH_TOKEN_LENGTH);
  });
});
