import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import { parsePairCommandArgs, probeCoordinatorReachability, runPairCommand } from './pair-cli';

/** Never touch this machine's Chrome or its running worker from a test. */
const offline = { setUpBrowser: () => [], isWorkerRunning: () => false, platform: 'linux' as NodeJS.Platform };

describe('pair-cli', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-worker-pair-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes canonical worker config from a pairing link without printing the token', async () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    const stdout = vi.fn();

    const result = await runPairCommand([
      'ai-orchestrator://remote-node/pair?host=macbook-pro.tail4fc107.ts.net&port=4878&namespace=default&token=pair-token&requireTls=false',
      '--config',
      configPath,
      '--name',
      'noah3900x',
      '--workdir',
      'C:\\work',
      '--no-probe',
      '--no-start',
    ], { ...offline, stdout });

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

    expect(result).toMatchObject({ exitCode: 0, startWorker: false, configPath });
    expect(persisted).toMatchObject({
      name: 'noah3900x',
      authToken: 'pair-token',
      coordinatorUrl: 'ws://macbook-pro.tail4fc107.ts.net:4878',
      namespace: 'default',
      workingDirectories: ['C:\\work'],
    });
    expect(stdout.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('pair-token');
  });

  it('pairs with the first fallback address that answers when the primary host does not', async () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    const stdout = vi.fn();
    const probeCoordinator = vi.fn(async (url: string) => {
      if (!url.includes('192.168.1.9')) throw new Error(`Coordinator is not reachable at ${new URL(url).host}: timeout`);
    });

    await runPairCommand([
      'ai-orchestrator://remote-node/pair?host=mac.tail.ts.net&port=4878&namespace=default&token=pair-token'
        + '&requireTls=false&fallbackHost=100.64.0.5&fallbackHost=192.168.1.9',
      '--config', configPath, '--name', 'ct-test-mac', '--no-start',
    ], { ...offline, stdout, probeCoordinator, isInteractive: false });

    expect(probeCoordinator.mock.calls.map((call) => call[0])).toEqual([
      'ws://mac.tail.ts.net:4878', 'ws://100.64.0.5:4878', 'ws://192.168.1.9:4878',
    ]);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(persisted['coordinatorUrl']).toBe('ws://192.168.1.9:4878');
    // The unanswered routes stay as fallbacks for later reconnects.
    expect(persisted['coordinatorUrls']).toEqual(['ws://mac.tail.ts.net:4878', 'ws://100.64.0.5:4878']);
    const output = stdout.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('mac.tail.ts.net:4878 did not answer; using 192.168.1.9:4878.');
    expect(output).not.toContain('pair-token');
  });

  it('writes nothing and reports every address when none answer', async () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    const probeCoordinator = vi.fn(async (url: string) => {
      throw new Error(`Coordinator is not reachable at ${new URL(url).host}: timeout`);
    });

    await expect(runPairCommand([
      'ai-orchestrator://remote-node/pair?host=mac.tail.ts.net&port=4878&token=pair-token&fallbackHost=192.168.1.9',
      '--config', configPath, '--no-start',
    ], { ...offline, stdout: vi.fn(), probeCoordinator, isInteractive: false })).rejects.toThrow(
      'Coordinator is not reachable at mac.tail.ts.net:4878: timeout\nCoordinator is not reachable at 192.168.1.9:4878: timeout',
    );
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("removes the previous pairing's worker report", async () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    const reportPath = path.join(tempDir, 'worker-node.status.json');
    fs.writeFileSync(reportPath, JSON.stringify({ state: 'failed', message: 'old pairing' }));

    await runPairCommand([
      'ai-orchestrator://remote-node/pair?host=mac&port=4878&namespace=default&token=pair-token&requireTls=false',
      '--config',
      configPath,
      '--no-probe',
      '--no-start',
    ], { ...offline, stdout: vi.fn() });

    expect(fs.existsSync(reportPath)).toBe(false);
  });

  it('prompts for display name and working directories during interactive pairing', async () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    const prompt = vi.fn()
      .mockResolvedValueOnce('windows-pc')
      .mockResolvedValueOnce('C:\\work, C:\\src');

    await runPairCommand([
      'ai-orchestrator://remote-node/pair?host=macbook-pro.tail4fc107.ts.net&port=4878&namespace=default&token=pair-token',
      '--config',
      configPath,
      '--no-probe',
      '--no-start',
    ], { ...offline, isInteractive: true, prompt });

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Worker display name'));
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Allowed working directories'));
    expect(persisted).toMatchObject({
      name: 'windows-pc',
      workingDirectories: ['C:\\work', 'C:\\src'],
    });
  });

  it('accepts a pretty multi-line canonical config during interactive pairing', async () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    const lines = JSON.stringify({
      authToken: 'pair-token',
      coordinatorUrl: 'ws://macbook-pro.tail4fc107.ts.net:4878',
      namespace: 'default',
    }, null, 2).split('\n');
    const prompt = vi.fn();
    for (const line of lines) {
      prompt.mockResolvedValueOnce(line);
    }

    await runPairCommand([
      '--config',
      configPath,
      '--name',
      'windows-pc',
      '--workdir',
      'C:\\work',
      '--no-probe',
      '--no-start',
    ], { ...offline, isInteractive: true, prompt });

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

    expect(prompt).toHaveBeenCalledTimes(lines.length);
    expect(persisted).toMatchObject({
      name: 'windows-pc',
      authToken: 'pair-token',
      coordinatorUrl: 'ws://macbook-pro.tail4fc107.ts.net:4878',
      workingDirectories: ['C:\\work'],
    });
  });

  it('clears stale node credentials when writing an explicit pairing config', async () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(configPath, JSON.stringify({
      name: 'old-worker',
      authToken: 'old-pairing-token',
      nodeToken: 'old-node-token',
      recoveryToken: 'old-recovery-token',
      coordinatorUrl: 'ws://old:4878',
      namespace: 'default',
      maxConcurrentInstances: 4,
      workingDirectories: [],
    }));

    await runPairCommand([
      'ai-orchestrator://remote-node/pair?host=macbook-pro.tail4fc107.ts.net&port=4878&namespace=default&token=new-pair-token',
      '--config',
      configPath,
      '--no-probe',
      '--no-start',
    ], { ...offline, stdout: vi.fn(), stderr: vi.fn() });

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(persisted['authToken']).toBe('new-pair-token');
    expect(persisted).not.toHaveProperty('nodeToken');
    expect(persisted).not.toHaveProperty('recoveryToken');
  });
});

describe('pair-cli computer set-up', () => {
  let tempDir: string;
  const link = 'ai-orchestrator://remote-node/pair?host=192.168.0.95&port=4878&namespace=default&token=pair-token';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-worker-pair-setup-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('sets up browser features unless --no-browser is given', async () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    const stdout = vi.fn();
    const setUpBrowser = vi.fn(() => ['Browser features turned on (Chrome found).']);

    await runPairCommand([link, '--config', configPath, '--no-probe', '--no-start'], {
      ...offline, stdout, setUpBrowser, isInteractive: false,
    });
    expect(setUpBrowser).toHaveBeenCalledWith(configPath);
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('Browser features turned on');

    setUpBrowser.mockClear();
    await runPairCommand([link, '--config', configPath, '--no-probe', '--no-start', '--no-browser'], {
      ...offline, stdout, setUpBrowser, isInteractive: false,
    });
    expect(setUpBrowser).not.toHaveBeenCalled();
  });

  it('tells a Mac user to allow Local Network access', async () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    const stdout = vi.fn();

    await runPairCommand([link, '--config', configPath, '--no-probe', '--no-start'], {
      ...offline, stdout, platform: 'darwin', isInteractive: false,
    });

    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('local network, click Allow');
  });

  it('leaves a worker that is waiting to be paired to connect, instead of starting a second one', async () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(configPath, JSON.stringify({ nodeId: 'node-1', name: 'ct-test-mac' }));
    fs.writeFileSync(path.join(tempDir, 'worker-node.status.json'), JSON.stringify({
      version: 1, pid: process.pid, nodeId: 'node-1', state: 'waiting_for_pairing', since: 1, updatedAt: Date.now(),
    }));
    const stdout = vi.fn();
    const isWorkerRunning = vi.fn(() => true);

    const result = await runPairCommand([link, '--config', configPath, '--no-probe'], {
      ...offline, stdout, isWorkerRunning, isInteractive: false,
    });

    expect(isWorkerRunning).toHaveBeenCalledWith('default:node-1');
    expect(result.startWorker).toBe(false);
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('was waiting to be paired and connects now');
  });

  it('says to restart a worker that is already running with an older pairing', async () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    const stdout = vi.fn();

    const result = await runPairCommand([link, '--config', configPath, '--no-probe'], {
      ...offline, stdout, isWorkerRunning: () => true, isInteractive: false,
    });

    expect(result.startWorker).toBe(false);
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('Restart it to use this pairing');
  });
});

describe('probeCoordinatorReachability', () => {
  it('reaches a coordinator by a bracketed IPv6 address', async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '::1', () => resolve()));
    const { port } = server.address() as net.AddressInfo;
    try {
      await expect(probeCoordinatorReachability(`ws://[::1]:${port}`, 2_000)).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('parsePairCommandArgs launcher argv shape', () => {
  it('accepts a bare pairing link', () => {
    expect(parsePairCommandArgs(['aio-pair://example']).input).toBe('aio-pair://example');
  });

  it('still rejects a genuinely unknown option', () => {
    expect(() => parsePairCommandArgs(['aio-pair://example', '--nonsense'])).toThrow(
      /Unknown pair option: --nonsense/,
    );
  });

  it('rejects --supervise, so index.ts must strip it before calling pair', () => {
    // start-worker.sh / start-worker.bat append --supervise to whatever the
    // user typed, which puts it in `pair`'s argv. This assertion pins WHY
    // index.ts filters the flag out before delegating: without that filter,
    // `start-worker.sh pair "<link>"` dies with a fatal error instead of
    // pairing. If pair ever learns to ignore the flag, delete the filter too.
    expect(() => parsePairCommandArgs(['aio-pair://example', '--supervise'])).toThrow(
      /Unknown pair option: --supervise/,
    );
  });
});
