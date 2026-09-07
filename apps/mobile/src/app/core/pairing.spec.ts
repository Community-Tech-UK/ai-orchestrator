import { describe, expect, it, afterEach, vi } from 'vitest';
import { unpairFromHost } from './pairing';
import type { PairedHost } from './models';

const HOST: PairedHost = {
  id: 'device-1',
  name: 'mac',
  host: '100.68.10.5',
  port: 4879,
  token: 'device-token',
  addedAt: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe('unpairFromHost', () => {
  it('asks the host to revoke this device, authenticated as itself', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(unpairFromHost(HOST)).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://100.68.10.5:4879/api/devices/me');
    expect((init as RequestInit).method).toBe('DELETE');
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer device-token',
    });
  });

  it('uses https when the host serves TLS', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await unpairFromHost({ ...HOST, secure: true });

    expect(fetchMock.mock.calls[0][0]).toBe('https://100.68.10.5:4879/api/devices/me');
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
