import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import {
  CATALOG_OVERRIDE_FILE_NAME,
  CatalogOverrideSource,
  parseCatalogOverrideJson,
} from './catalog-override-source';

describe('parseCatalogOverrideJson', () => {
  it('accepts a per-provider override map and normalizes valid model entries', () => {
    const parsed = parseCatalogOverrideJson(JSON.stringify({
      Claude: [
        {
          id: ' claude-future-opus ',
          name: 'Future Opus',
          tier: 'powerful',
          family: 'Opus',
          pricing: { inputPerMillion: 10, outputPerMillion: 50 },
          contextWindow: 1_000_000,
          maxOutputTokens: 32_000,
        },
      ],
    }), 'local', 123);

    expect(parsed).toEqual([{
      id: 'claude-future-opus',
      provider: 'claude',
      name: 'Future Opus',
      tier: 'powerful',
      family: 'Opus',
      pricing: { inputPerMillion: 10, outputPerMillion: 50 },
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      origin: 'local',
      source: 'catalog-override',
      discoveredAt: 123,
    }]);
  });

  it('rejects malformed override payloads instead of returning partial data', () => {
    expect(parseCatalogOverrideJson(JSON.stringify({
      claude: [{ id: '', tier: 'fast' }],
    }), 'local', 123)).toBeNull();
    expect(parseCatalogOverrideJson(JSON.stringify({
      claude: [{ id: 'model-ok', name: '   ' }],
    }), 'local', 123)).toBeNull();
    expect(parseCatalogOverrideJson(JSON.stringify({
      claude: [{ id: 'ok', pricing: { inputPerMillion: -1, outputPerMillion: 2 } }],
    }), 'remote', 123)).toBeNull();
  });

  it('rejects duplicate provider/model entries instead of silently keeping the last one', () => {
    expect(parseCatalogOverrideJson(JSON.stringify({
      claude: [
        { id: 'claude-duplicate', name: 'First' },
        { id: 'claude-duplicate', name: 'Second' },
      ],
    }), 'local', 123)).toBeNull();
  });

  it('rejects payloads that mix providers wrapper and top-level provider maps', () => {
    expect(parseCatalogOverrideJson(JSON.stringify({
      providers: {
        claude: [{ id: 'claude-wrapped' }],
      },
      codex: [{ id: 'gpt-top-level' }],
    }), 'remote', 123)).toBeNull();
  });
});

describe('CatalogOverrideSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads models-override.json from user data and watches for changes', async () => {
    let raw = JSON.stringify({
      claude: [{ id: 'claude-local-opus', name: 'Local Opus' }],
    });
    let watchedPath = '';
    let watchListener: (() => void) | null = null;
    const source = new CatalogOverrideSource({
      readFile: vi.fn(async () => raw),
      mkdir: vi.fn(async () => undefined),
      watchDirectory: vi.fn((path, listener) => {
        watchedPath = path;
        watchListener = listener;
        return { close: vi.fn() };
      }),
      now: () => 1000,
    });

    await source.startLocal('/tmp/aio-user-data');

    expect(watchedPath).toBe('/tmp/aio-user-data');
    expect(source.getEntries().map((entry) => entry.id)).toEqual(['claude-local-opus']);

    raw = JSON.stringify({
      gemini: [{ id: 'gemini-local-pro', tier: 'powerful' }],
    });
    watchListener?.();
    await vi.advanceTimersByTimeAsync(200);

    expect(source.getEntries().map((entry) => `${entry.provider}:${entry.id}`)).toEqual([
      'gemini:gemini-local-pro',
    ]);
  });

  it('keeps the last valid local override when a file change is malformed', async () => {
    let raw = JSON.stringify({
      claude: [{ id: 'claude-valid' }],
    });
    const source = new CatalogOverrideSource({
      readFile: vi.fn(async () => raw),
      mkdir: vi.fn(async () => undefined),
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
      now: () => 1000,
    });

    await source.startLocal('/tmp/aio-user-data');
    raw = '{ invalid json';

    await source.refreshLocal();

    expect(source.getEntries().map((entry) => entry.id)).toEqual(['claude-valid']);
  });

  it('keeps the last valid local override when a local file exceeds the size cap', async () => {
    let raw = JSON.stringify({
      claude: [{ id: 'claude-valid' }],
    });
    const source = new CatalogOverrideSource({
      readFile: vi.fn(async () => raw),
      mkdir: vi.fn(async () => undefined),
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
      now: () => 1000,
    });

    await source.startLocal('/tmp/aio-user-data');
    raw = `${' '.repeat((2 * 1024 * 1024) + 1)}${JSON.stringify({
      claude: [{ id: 'claude-too-large' }],
    })}`;
    await source.refreshLocal();

    expect(source.getEntries().map((entry) => entry.id)).toEqual(['claude-valid']);
  });

  it('clears local entries when the local source stops', async () => {
    const source = new CatalogOverrideSource({
      readFile: vi.fn(async () => JSON.stringify({
        claude: [{ id: 'claude-local-opus' }],
      })),
      mkdir: vi.fn(async () => undefined),
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
      now: () => 1000,
    });

    await source.startLocal('/tmp/aio-user-data');
    const listener = vi.fn();
    source.on('updated', listener);

    source.stopLocal();

    expect(source.getEntries()).toEqual([]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('does not emit an update when valid local entries only reorder', async () => {
    let raw = JSON.stringify({
      providers: {
        claude: [
          { id: 'claude-a' },
          { id: 'claude-b' },
        ],
      },
    });
    const source = new CatalogOverrideSource({
      readFile: vi.fn(async () => raw),
      mkdir: vi.fn(async () => undefined),
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
      now: () => 1000,
    });

    await source.startLocal('/tmp/aio-user-data');
    const listener = vi.fn();
    source.on('updated', listener);

    raw = JSON.stringify({
      providers: {
        claude: [
          { id: 'claude-b' },
          { id: 'claude-a' },
        ],
      },
    });
    await source.refreshLocal();

    expect(listener).not.toHaveBeenCalled();
  });

  it('writes a local override entry and refreshes the in-memory catalog source', async () => {
    let raw = JSON.stringify({
      providers: {
        claude: [{ id: 'claude-existing-opus', name: 'Existing Opus' }],
      },
    });
    const writeFile = vi.fn(async (_path: string, contents: string) => {
      raw = contents;
    });
    const source = new CatalogOverrideSource({
      readFile: vi.fn(async () => raw),
      writeFile,
      mkdir: vi.fn(async () => undefined),
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
      now: () => 1000,
    });

    await source.startLocal('/tmp/aio-user-data');
    await source.setLocalOverrideModel('Claude', ' claude-ui-opus ', {
      name: 'UI Opus',
      tier: 'powerful',
      family: 'Opus',
      contextWindow: 1_000_000,
    });

    expect(writeFile).toHaveBeenCalledWith(
      path.join('/tmp/aio-user-data', CATALOG_OVERRIDE_FILE_NAME),
      expect.stringContaining('claude-ui-opus'),
    );
    expect(source.getEntries().map((entry) => ({
      provider: entry.provider,
      id: entry.id,
      name: entry.name,
      tier: entry.tier,
      origin: entry.origin,
    }))).toEqual([
      {
        provider: 'claude',
        id: 'claude-existing-opus',
        name: 'Existing Opus',
        tier: undefined,
        origin: 'local',
      },
      {
        provider: 'claude',
        id: 'claude-ui-opus',
        name: 'UI Opus',
        tier: 'powerful',
        origin: 'local',
      },
    ]);
  });

  it('serializes concurrent local override writes so one update cannot overwrite another', async () => {
    let raw = JSON.stringify({ providers: {} });
    const writeFile = vi.fn(async (_path: string, contents: string) => {
      raw = contents;
    });
    const source = new CatalogOverrideSource({
      readFile: vi.fn(async () => raw),
      writeFile,
      mkdir: vi.fn(async () => undefined),
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
      now: () => 1000,
    });

    await source.startLocal('/tmp/aio-user-data');
    await Promise.all([
      source.setLocalOverrideModel('claude', 'claude-concurrent-a'),
      source.setLocalOverrideModel('claude', 'claude-concurrent-b'),
    ]);

    expect(source.getEntries().map((entry) => entry.id).sort()).toEqual([
      'claude-concurrent-a',
      'claude-concurrent-b',
    ]);
  });

  it('removes a local override entry from disk without touching other providers', async () => {
    let raw = JSON.stringify({
      providers: {
        claude: [{ id: 'claude-local-opus' }],
        codex: [{ id: 'gpt-local-codex' }],
      },
    });
    const writeFile = vi.fn(async (_path: string, contents: string) => {
      raw = contents;
    });
    const source = new CatalogOverrideSource({
      readFile: vi.fn(async () => raw),
      writeFile,
      mkdir: vi.fn(async () => undefined),
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
      now: () => 1000,
    });

    await source.startLocal('/tmp/aio-user-data');
    await expect(source.removeLocalOverrideModel('claude', 'claude-local-opus')).resolves.toBe(true);

    expect(writeFile).toHaveBeenCalledWith(
      path.join('/tmp/aio-user-data', CATALOG_OVERRIDE_FILE_NAME),
      expect.not.stringContaining('claude-local-opus'),
    );
    expect(source.getEntries().map((entry) => `${entry.provider}:${entry.id}`)).toEqual([
      'codex:gpt-local-codex',
    ]);
  });

  it('does not treat a blank provider as a cross-provider remove request', async () => {
    let raw = JSON.stringify({
      providers: {
        claude: [{ id: 'shared-local-model' }],
        codex: [{ id: 'shared-local-model' }],
      },
    });
    const writeFile = vi.fn(async (_path: string, contents: string) => {
      raw = contents;
    });
    const source = new CatalogOverrideSource({
      readFile: vi.fn(async () => raw),
      writeFile,
      mkdir: vi.fn(async () => undefined),
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
      now: () => 1000,
    });

    await source.startLocal('/tmp/aio-user-data');
    await expect(source.removeLocalOverrideModel('   ', 'shared-local-model')).resolves.toBe(false);

    expect(writeFile).not.toHaveBeenCalled();
    expect(source.getEntries().map((entry) => `${entry.provider}:${entry.id}`)).toEqual([
      'claude:shared-local-model',
      'codex:shared-local-model',
    ]);
  });

  it('fetches a remote override only when the network policy allows the URL', async () => {
    const fetchText = vi.fn(async () => JSON.stringify({
      codex: [{ id: 'gpt-remote-codex', tier: 'powerful' }],
    }));
    const source = new CatalogOverrideSource({
      fetchText,
      networkPolicy: {
        recordRequest: vi.fn(() => ({
          url: 'https://blocked.example/models-override.json',
          domain: 'blocked.example',
          method: 'GET',
          timestamp: 1,
          allowed: false,
          reason: 'Domain not in allowlist',
        })),
      },
      now: () => 2000,
    });

    await source.setRemoteOverrideUrl('https://blocked.example/models-override.json');

    expect(fetchText).not.toHaveBeenCalled();
    expect(source.getEntries()).toEqual([]);

    const allowedSource = new CatalogOverrideSource({
      fetchText,
      networkPolicy: {
        recordRequest: vi.fn(() => ({
          url: 'https://catalog.example/models-override.json',
          domain: 'catalog.example',
          method: 'GET',
          timestamp: 2,
          allowed: true,
          reason: 'Domain is in allowlist',
        })),
      },
      now: () => 3000,
    });

    await allowedSource.setRemoteOverrideUrl('https://catalog.example/models-override.json');

    expect(fetchText).toHaveBeenCalledWith(
      'https://catalog.example/models-override.json',
      expect.objectContaining({
        maxRedirects: expect.any(Number),
        networkPolicy: expect.any(Object),
      }),
    );
    expect(allowedSource.getEntries()).toMatchObject([{
      id: 'gpt-remote-codex',
      provider: 'codex',
      source: 'catalog-override',
      origin: 'remote',
      tier: 'powerful',
    }]);
  });

  it('does not refetch when settings reapply the same remote override URL', async () => {
    const fetchText = vi.fn(async () => JSON.stringify({
      codex: [{ id: 'gpt-remote-codex' }],
    }));
    const source = new CatalogOverrideSource({
      fetchText,
      networkPolicy: {
        recordRequest: vi.fn((url: string) => ({
          url,
          domain: new URL(url).hostname,
          method: 'GET',
          timestamp: 1,
          allowed: true,
          reason: 'Domain is in allowlist',
        })),
      },
      now: () => 1000,
    });

    await source.setRemoteOverrideUrl('https://catalog.example/models-override.json');
    await source.setRemoteOverrideUrl('https://catalog.example/models-override.json');

    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('clamps invalid remote refresh intervals so refreshRemote cannot hot-loop', async () => {
    let now = 1000;
    const fetchText = vi.fn(async () => JSON.stringify({
      codex: [{ id: 'gpt-remote-codex' }],
    }));
    const source = new CatalogOverrideSource({
      fetchText,
      networkPolicy: {
        recordRequest: vi.fn((url: string) => ({
          url,
          domain: new URL(url).hostname,
          method: 'GET',
          timestamp: now,
          allowed: true,
          reason: 'Domain is in allowlist',
        })),
      },
      now: () => now,
      remoteRefreshIntervalMs: 0,
    });

    await source.setRemoteOverrideUrl('https://catalog.example/models-override.json');
    now = 1001;
    await source.refreshRemote(false);

    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('follows remote redirects only after checking the redirected URL against network policy', async () => {
    vi.useRealTimers();
    const targetServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        providers: {
          codex: [{ id: 'gpt-redirected-codex' }],
        },
      }));
    });
    const targetBaseUrl = await listen(targetServer);
    const redirectServer = http.createServer((_req, res) => {
      res.writeHead(302, { location: `${targetBaseUrl}/models-override.json` });
      res.end();
    });
    const redirectBaseUrl = await listen(redirectServer);
    const recordRequest = vi.fn((url: string, method?: string) => ({
      url,
      domain: new URL(url).hostname,
      method: method ?? 'GET',
      timestamp: 1,
      allowed: true,
      reason: 'Domain is in allowlist',
    }));
    const source = new CatalogOverrideSource({
      networkPolicy: { recordRequest },
      now: () => 5000,
    });

    try {
      await source.setRemoteOverrideUrl(`${redirectBaseUrl}/models-override.json`);
    } finally {
      await closeServer(redirectServer);
      await closeServer(targetServer);
    }

    expect(source.getEntries()).toMatchObject([{
      id: 'gpt-redirected-codex',
      provider: 'codex',
      origin: 'remote',
    }]);
    expect(recordRequest).toHaveBeenCalledWith(`${redirectBaseUrl}/models-override.json`, 'GET');
    expect(recordRequest).toHaveBeenCalledWith(`${targetBaseUrl}/models-override.json`, 'GET');
  });

  it('does not emit an update when an identical remote refresh only changes discovery time', async () => {
    let now = 1000;
    const fetchText = vi.fn(async () => JSON.stringify({
      providers: {
        codex: [{ id: 'gpt-remote-codex', tier: 'powerful' }],
      },
    }));
    const source = new CatalogOverrideSource({
      fetchText,
      networkPolicy: {
        recordRequest: vi.fn((url: string) => ({
          url,
          domain: new URL(url).hostname,
          method: 'GET',
          timestamp: now,
          allowed: true,
          reason: 'Domain is in allowlist',
        })),
      },
      now: () => now,
    });

    await source.setRemoteOverrideUrl('https://catalog.example/models-override.json');
    const listener = vi.fn();
    source.on('updated', listener);

    now = 2000;
    await source.refreshRemote(true);

    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalled();
    expect(source.getEntries()).toMatchObject([{
      id: 'gpt-remote-codex',
      provider: 'codex',
      origin: 'remote',
      discoveredAt: 1000,
    }]);
  });

  it('ignores an in-flight remote fetch result after the source stops', async () => {
    let resolveFetch: ((value: string) => void) | null = null;
    const fetchText = vi.fn(() => new Promise<string>((resolve) => {
      resolveFetch = resolve;
    }));
    const source = new CatalogOverrideSource({
      fetchText,
      networkPolicy: {
        recordRequest: vi.fn((url: string) => ({
          url,
          domain: new URL(url).hostname,
          method: 'GET',
          timestamp: 1,
          allowed: true,
          reason: 'Domain is in allowlist',
        })),
      },
      now: () => 1000,
    });
    const pending = source.setRemoteOverrideUrl('https://catalog.example/models-override.json');
    await Promise.resolve();
    const listener = vi.fn();
    source.on('updated', listener);

    source.stop();
    resolveFetch?.(JSON.stringify({
      codex: [{ id: 'gpt-stale-after-stop' }],
    }));
    await pending;

    expect(source.getEntries()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores a stale remote fetch result after the configured URL changes', async () => {
    let resolveFirst: ((value: string) => void) | null = null;
    const fetchText = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(JSON.stringify({
        gemini: [{ id: 'second-url-model' }],
      }));
    const source = new CatalogOverrideSource({
      fetchText,
      networkPolicy: {
        recordRequest: vi.fn((url: string) => ({
          url,
          domain: new URL(url).hostname,
          method: 'GET',
          timestamp: 1,
          allowed: true,
          reason: 'Domain is in allowlist',
        })),
      },
      now: () => 4000,
    });

    const first = source.setRemoteOverrideUrl('https://first.example/models.json');
    await Promise.resolve();
    const second = source.setRemoteOverrideUrl('https://second.example/models.json');
    await second;
    resolveFirst?.(JSON.stringify({
      claude: [{ id: 'first-url-model' }],
    }));
    await first;

    expect(source.getEntries().map((entry) => entry.id)).toEqual(['second-url-model']);
  });
});

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Server did not bind to an address'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
