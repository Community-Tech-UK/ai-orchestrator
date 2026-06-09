import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { RemoteBrowserConnector } from './remote-browser-connector';

function makeFakeBrowser(pages: unknown[] = [{ goto: vi.fn(async () => undefined) }]) {
  return {
    pages: vi.fn(async () => pages),
    newPage: vi.fn(async () => ({ goto: vi.fn(async () => undefined) })),
    disconnect: vi.fn(async () => undefined),
  };
}

function makeConnector(browser = makeFakeBrowser()) {
  const tunnelClient = { connectBrowser: vi.fn(async () => browser as never) };
  const setRuntimeState = vi.fn();
  const connector = new RemoteBrowserConnector({
    tunnelClient,
    profileStore: { setRuntimeState } as never,
  });
  return { connector, tunnelClient, setRuntimeState, browser };
}

describe('RemoteBrowserConnector', () => {
  let h: ReturnType<typeof makeConnector>;
  beforeEach(() => {
    h = makeConnector();
  });

  it('connects via the tunnel client and tracks the browser', async () => {
    const runtime = await h.connector.connect('p1', 'node-x');
    expect(h.tunnelClient.connectBrowser).toHaveBeenCalledWith('node-x');
    expect(h.connector.getBrowser('p1')).toBe(h.browser);
    expect(runtime).toEqual({ debugPort: 0, debugEndpoint: 'remote://node-x' });
  });

  it('marks the profile running with a remote debug endpoint', async () => {
    await h.connector.connect('p1', 'node-x');
    expect(h.setRuntimeState).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ status: 'running', debugEndpoint: 'remote://node-x' }),
    );
  });

  it('navigates the first page to the start URL when provided', async () => {
    const page = { goto: vi.fn(async () => undefined) };
    h = makeConnector(makeFakeBrowser([page]));
    await h.connector.connect('p1', 'node-x', 'https://www.facebook.com');
    expect(page.goto).toHaveBeenCalledWith(
      'https://www.facebook.com',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
  });

  it('opens a new page when the browser has none', async () => {
    const browser = makeFakeBrowser([]);
    h = makeConnector(browser);
    await h.connector.connect('p1', 'node-x', 'https://x');
    expect(browser.newPage).toHaveBeenCalled();
  });

  it('close() disconnects (does not kill) and marks the profile stopped', async () => {
    await h.connector.connect('p1', 'node-x');
    await h.connector.close('p1');
    expect(h.browser.disconnect).toHaveBeenCalledTimes(1);
    expect(h.connector.getBrowser('p1')).toBeNull();
    expect(h.setRuntimeState).toHaveBeenLastCalledWith(
      'p1',
      expect.objectContaining({ status: 'stopped' }),
    );
  });

  it('reconnecting closes the prior browser first', async () => {
    await h.connector.connect('p1', 'node-x');
    const first = h.browser;
    await h.connector.connect('p1', 'node-y');
    expect(first.disconnect).toHaveBeenCalled();
  });

  it('swallows runtime-state errors on close (profile may be deleted)', async () => {
    await h.connector.connect('p1', 'node-x');
    h.setRuntimeState.mockImplementationOnce(() => {
      throw new Error('not found');
    });
    await expect(h.connector.close('p1')).resolves.toBeUndefined();
  });

  it('closeAll disconnects every tracked browser', async () => {
    await h.connector.connect('p1', 'node-x');
    await h.connector.closeAll();
    expect(h.connector.getBrowser('p1')).toBeNull();
  });
});
