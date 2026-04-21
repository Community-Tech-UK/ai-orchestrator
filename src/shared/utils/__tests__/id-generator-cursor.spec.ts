import { describe, it, expect } from 'vitest';
import { INSTANCE_ID_PREFIXES, generateInstanceId } from '../id-generator';

describe('INSTANCE_ID_PREFIXES — cursor', () => {
  it('assigns u to cursor', () => {
    expect(INSTANCE_ID_PREFIXES.cursor).toBe('u');
  });

  it('generateInstanceId("cursor") produces a u-prefixed ID', () => {
    const id = generateInstanceId('cursor');
    // generatePrefixedId appends 8 chars from [0-9a-z]
    expect(id).toMatch(/^u[0-9a-z]{8}$/);
  });
});
