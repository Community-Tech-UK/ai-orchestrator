import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../worker-config';

describe('loadWorkerConfig', () => {
  let tempDir: string;
  let originalArgv: string[];
  let originalWorkerToken: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-config-'));
    originalArgv = process.argv;
    originalWorkerToken = process.env['AIO_WORKER_TOKEN'];
    process.argv = ['node', 'worker-agent'];
    delete process.env['AIO_WORKER_TOKEN'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalWorkerToken === undefined) {
      delete process.env['AIO_WORKER_TOKEN'];
    } else {
      process.env['AIO_WORKER_TOKEN'] = originalWorkerToken;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts the UI-generated pairing config shape used by start-worker.bat', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        token: 'pair-token',
        host: 'macbook-pro.tail4fc107.ts.net',
        port: 4878,
        requireTls: false,
        namespace: 'default',
      }),
    );

    const config = loadWorkerConfig(configPath);

    expect(config.authToken).toBe('pair-token');
    expect(config.coordinatorUrl).toBe('ws://macbook-pro.tail4fc107.ts.net:4878');
    expect(config.namespace).toBe('default');
  });

  it('uses wss for UI-generated pairing config when TLS is required', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        token: 'pair-token',
        host: '100.68.10.5',
        port: 4878,
        requireTls: true,
      }),
    );

    const config = loadWorkerConfig(configPath);

    expect(config.coordinatorUrl).toBe('wss://100.68.10.5:4878');
  });

  it('lets copied UI host and port replace a stale persisted coordinatorUrl', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        token: 'pair-token',
        authToken: 'pair-token',
        host: 'macbook-pro.tail4fc107.ts.net',
        port: 4878,
        requireTls: false,
        coordinatorUrl: 'ws://192.168.0.156:4878',
      }),
    );

    const config = loadWorkerConfig(configPath);

    expect(config.coordinatorUrl).toBe('ws://macbook-pro.tail4fc107.ts.net:4878');
  });
});
