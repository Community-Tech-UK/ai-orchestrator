import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.types';

describe('DEFAULT_SETTINGS — thin-client WebSocket', () => {
  it('enables the dedicated thin-client endpoint in stock config while remote nodes stay opt-in', () => {
    expect(DEFAULT_SETTINGS.thinClientWsEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.thinClientWsHost).toBe('127.0.0.1');
    expect(DEFAULT_SETTINGS.thinClientWsPort).toBe(4880);
    expect(DEFAULT_SETTINGS.remoteNodesEnabled).toBe(false);
  });
});
