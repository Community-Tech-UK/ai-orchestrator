import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPairCommand } from './pair-cli';

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
    ], { stdout });

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
    ], { isInteractive: true, prompt });

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
    ], { isInteractive: true, prompt });

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
    ], { stdout: vi.fn(), stderr: vi.fn() });

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(persisted['authToken']).toBe('new-pair-token');
    expect(persisted).not.toHaveProperty('nodeToken');
    expect(persisted).not.toHaveProperty('recoveryToken');
  });
});
