import { describe, expect, it, afterEach, vi } from 'vitest';
import { pairWithHost, parsePairingCode, unpairFromHost, validatePairingPayload } from './pairing';
import type { PairedHost } from './models';

const HOST: PairedHost = {
  id: 'device-1',
  name: 'mac',
  host: 'example.test',
  port: 4879,
  token: 'PLACEHOLDER_DEVICE',
  addedAt: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe('unpairFromHost', () => {
  it('asks the host to revoke this device, authenticated as itself', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(unpairFromHost(HOST)).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://example.test:4879/api/devices/me');
    expect((init as RequestInit).method).toBe('DELETE');
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer PLACEHOLDER_DEVICE',
    });
  });

  it('uses https when the host serves TLS', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await unpairFromHost({ ...HOST, secure: true });

    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test:4879/api/devices/me');
  });

  /**
   * Removing a host usually happens *because* it is unreachable or its token has
   * already expired. Reporting false (rather than throwing) lets the caller drop
   * the local entry anyway and still tell the user the token may be live.
   */
  it('reports failure instead of throwing when the host cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
    await expect(unpairFromHost(HOST)).resolves.toBe(false);
  });

  it('reports failure when the host rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response));
    await expect(unpairFromHost(HOST)).resolves.toBe(false);
  });
});

const CODE = { v: 1, host: 'example.test', port: 4879, pairingToken: 'PLACEHOLDER_PAIRING' };
describe('complete connection-code validation', () => {
  it('accepts desktop codes and preserves TLS with trimmed values', () => {
    expect(parsePairingCode(JSON.stringify({ ...CODE, host: ' example.test ', secure: true }))).toEqual({ payload: { ...CODE, secure: true }, error: null });
    expect(validatePairingPayload({ ...CODE, host: '[::1]' }).error).toBeNull();
  });

  it.each([null, [], 'text', {}, { ...CODE, v: 2 }, { ...CODE, pairingToken: '' }, { ...CODE, pairingToken: undefined },
    { ...CODE, port: 0 }, { ...CODE, port: 65536 }, { ...CODE, port: 1.5 }, { ...CODE, port: '4879' },
    { ...CODE, host: 'https://example.test' }, { ...CODE, host: 'example.test/path' },
    { ...CODE, host: 'user@example.test' }, { ...CODE, host: 'example.test:4879' }, { ...CODE, secure: 'false' },
  ])('rejects incomplete or malformed payload %# atomically', (value) => {
    const result = validatePairingPayload(value);
    expect(result.payload).toBeNull();
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain('PLACEHOLDER');
  });

  it('does not expose malformed code in validation feedback', () => {
    const result = parsePairingCode('PLACEHOLDER_PRIVATE_INPUT');
    expect(result.payload).toBeNull();
    expect(result.error).not.toContain('PLACEHOLDER');
  });
});

describe('pairing failure guidance', () => {
  it('explains expired codes without rendering the server response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'PLACEHOLDER_PRIVATE_INPUT' }) }));
    await expect(pairWithHost(CODE.host, CODE.port, CODE.pairingToken, 'Phone')).rejects.toThrow('Generate a new code');
  });

  it('does not echo arbitrary server errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'PLACEHOLDER_PRIVATE_INPUT' }) }));
    await expect(pairWithHost(CODE.host, CODE.port, CODE.pairingToken, 'Phone')).rejects.toThrow('Check that the gateway is running');
  });

  it('gives network advice only when the host cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PLACEHOLDER_PRIVATE_INPUT')));
    await expect(pairWithHost(CODE.host, CODE.port, CODE.pairingToken, 'Phone')).rejects.toThrow('Tailscale');
  });
});
