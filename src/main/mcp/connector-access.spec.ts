import { describe, expect, it } from 'vitest';
import { ConnectorAccessRegistry } from './connector-access';
describe('session connector grants', () => {
  it('limits access to the exact session grant and replaces it on a new spawn', () => {
    const access = new ConnectorAccessRegistry();
    expect(() => access.assert('session-a', 'private')).toThrow('not given');
    access.grant('session-a', ['private']);
    expect(() => access.assert('session-a', 'private')).not.toThrow();
    expect(() => access.assert('session-b', 'private')).toThrow('not given');
    access.grant('session-a', []);
    expect(() => access.assert('session-a', 'private')).toThrow('not given');
  });
});
