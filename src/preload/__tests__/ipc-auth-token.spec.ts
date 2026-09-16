import { describe, expect, it } from 'vitest';
import { readIpcAuthToken } from '../ipc-auth-token';

describe('readIpcAuthToken', () => {
  it('accepts a string token and rejects malformed appReady data', () => {
    expect(readIpcAuthToken({ ipcAuthToken: 'token-1' })).toBe('token-1');
    expect(readIpcAuthToken({ ipcAuthToken: '' })).toBeUndefined();
    expect(readIpcAuthToken({ ipcAuthToken: 12 })).toBeUndefined();
    expect(readIpcAuthToken(null)).toBeUndefined();
    expect(readIpcAuthToken('token-1')).toBeUndefined();
  });
});
