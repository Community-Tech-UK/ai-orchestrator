import { describe, expect, it } from 'vitest';
import {
  parsePairingConfigInput,
  sanitizePairingErrorMessage,
} from './pairing-config';

describe('pairing-config', () => {
  it('parses ai-orchestrator pairing links into canonical worker config fields', () => {
    const parsed = parsePairingConfigInput(
      'ai-orchestrator://remote-node/pair?host=macbook-pro.tail4fc107.ts.net&port=4878&namespace=default&token=pair-token&requireTls=false',
    );

    expect(parsed).toEqual({
      authToken: 'pair-token',
      coordinatorUrl: 'ws://macbook-pro.tail4fc107.ts.net:4878',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
    });
  });

  it('parses canonical JSON connection config', () => {
    const parsed = parsePairingConfigInput(JSON.stringify({
      name: 'Noah3900x',
      authToken: 'pair-token',
      coordinatorUrl: 'wss://macbook-pro.tail4fc107.ts.net:4878',
      namespace: 'default',
      maxConcurrentInstances: 8,
      workingDirectories: ['C:\\work'],
    }));

    expect(parsed).toEqual({
      name: 'Noah3900x',
      authToken: 'pair-token',
      coordinatorUrl: 'wss://macbook-pro.tail4fc107.ts.net:4878',
      namespace: 'default',
      maxConcurrentInstances: 8,
      workingDirectories: ['C:\\work'],
    });
  });

  it('strips query and fragment data from pasted coordinator URLs', () => {
    const parsed = parsePairingConfigInput(JSON.stringify({
      authToken: 'pair-token',
      coordinatorUrl: 'wss://macbook-pro.tail4fc107.ts.net:4878/worker?token=secret#pairing',
      namespace: 'default',
    }));

    expect(parsed.coordinatorUrl).toBe('wss://macbook-pro.tail4fc107.ts.net:4878/worker');
  });

  it('keeps accepting the legacy UI JSON config shape', () => {
    const parsed = parsePairingConfigInput(JSON.stringify({
      token: 'pair-token',
      host: '100.106.40.97',
      port: 4878,
      requireTls: true,
      namespace: 'default',
    }));

    expect(parsed.coordinatorUrl).toBe('wss://100.106.40.97:4878');
    expect(parsed.authToken).toBe('pair-token');
  });

  it('rejects malformed input without echoing secrets', () => {
    const secret = 'secret-pair-token-1234567890';

    expect(() => parsePairingConfigInput(JSON.stringify({ authToken: secret })))
      .toThrow(/missing coordinatorUrl/i);
    expect(sanitizePairingErrorMessage(new Error(`bad ${secret}`), secret))
      .toBe('bad [redacted]');
  });
});
