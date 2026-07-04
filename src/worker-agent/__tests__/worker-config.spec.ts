import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertWorkerConfigHasCoordinator,
  getConfiguredCoordinatorUrl,
  loadWorkerConfig,
} from '../worker-config';

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

  it('strips a UTF-8 BOM from the config file (PowerShell 5 Set-Content / Notepad write one)', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      '\uFEFF' +
        JSON.stringify({
          name: 'bom-node',
          authToken: 'tok',
          coordinatorUrl: 'ws://100.68.10.5:4878',
        }),
    );

    const config = loadWorkerConfig(configPath);

    expect(config.name).toBe('bom-node');
    expect(config.coordinatorUrl).toBe('ws://100.68.10.5:4878');
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

  it('uses but does not persist an auth token sourced from the environment', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        authToken: 'file-token',
        namespace: 'default',
      }),
    );
    process.env['AIO_WORKER_TOKEN'] = 'env-token';

    const config = loadWorkerConfig(configPath);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { authToken?: string };

    expect(config.authToken).toBe('env-token');
    expect(persisted.authToken).toBe('file-token');
    expect(JSON.stringify(persisted)).not.toContain('env-token');
  });

  it('leaves browserAutomation undefined when absent', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(configPath, JSON.stringify({ token: 't', namespace: 'default' }));
    const config = loadWorkerConfig(configPath);
    expect(config.browserAutomation).toBeUndefined();
  });

  it('parses an enabled browserAutomation block', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        token: 't',
        browserAutomation: {
          enabled: true,
          profileDir: 'C:/auto-profile',
          headless: true,
          chromePath: 'C:/chrome.exe',
          remoteDebuggingPort: 9222,
        },
      }),
    );
    const config = loadWorkerConfig(configPath);
    expect(config.browserAutomation).toEqual({
      enabled: true,
      profileDir: 'C:/auto-profile',
      headless: true,
      chromePath: 'C:/chrome.exe',
      remoteDebuggingPort: 9222,
    });
  });

  it('treats a block without enabled:true as off (never silently enabled)', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ token: 't', browserAutomation: { profileDir: 'C:/x', headless: true } }),
    );
    const config = loadWorkerConfig(configPath);
    expect(config.browserAutomation).toBeUndefined();
  });

  it('drops malformed optional fields but keeps enablement', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        token: 't',
        browserAutomation: {
          enabled: true,
          profileDir: '   ',
          headless: 'yes',
          remoteDebuggingPort: 70000,
        },
      }),
    );
    const config = loadWorkerConfig(configPath);
    expect(config.browserAutomation).toEqual({ enabled: true });
  });

  it('generates local extension relay defaults when enabled without secrets', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        token: 't',
        extensionRelay: {
          enabled: true,
        },
      }),
    );

    const config = loadWorkerConfig(configPath);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      extensionRelay?: { enabled?: boolean; socketPath?: string; extensionToken?: string };
    };

    expect(config.extensionRelay?.enabled).toBe(true);
    expect(config.extensionRelay?.socketPath).toBeTruthy();
    expect(config.extensionRelay?.extensionToken).toHaveLength(64);
    expect(config.extensionRelay?.legacyNameRegistration).toBe(true);
    expect(persisted.extensionRelay?.extensionToken).toBe(config.extensionRelay?.extensionToken);
  });

  it('preserves an explicit disabled legacy extension relay registration flag', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        token: 't',
        extensionRelay: {
          enabled: true,
          legacyNameRegistration: false,
        },
      }),
    );

    const config = loadWorkerConfig(configPath);

    expect(config.extensionRelay?.enabled).toBe(true);
    expect(config.extensionRelay?.legacyNameRegistration).toBe(false);
  });

  it('parses an enabled androidAutomation block with safe defaults', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        token: 't',
        androidAutomation: {
          enabled: true,
          sdkPath: 'C:/Android/Sdk',
          defaultAvd: 'aio-pixel7-api35',
          headlessEmulator: false,
          maxEmulators: 2,
          bootTimeoutMs: 240000,
          allowPhysicalDevices: false,
          injectMaestroMcp: true,
          appiumMcp: true,
          mobileMcpVersion: '0.0.59',
        },
      }),
    );
    const config = loadWorkerConfig(configPath);
    expect(config.androidAutomation).toEqual({
      enabled: true,
      sdkPath: 'C:/Android/Sdk',
      defaultAvd: 'aio-pixel7-api35',
      headlessEmulator: false,
      maxEmulators: 2,
      bootTimeoutMs: 240000,
      allowPhysicalDevices: false,
      injectMaestroMcp: true,
      appiumMcp: true,
      mobileMcpVersion: '0.0.59',
    });
  });

  it('treats androidAutomation without enabled:true as off', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ token: 't', androidAutomation: { sdkPath: 'C:/Android/Sdk' } }),
    );
    const config = loadWorkerConfig(configPath);
    expect(config.androidAutomation).toBeUndefined();
  });

  it('drops malformed androidAutomation optional fields while applying defaults', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        token: 't',
        androidAutomation: {
          enabled: true,
          sdkPath: ' ',
          defaultAvd: '',
          headlessEmulator: 'yes',
          maxEmulators: 9,
          bootTimeoutMs: -1,
          allowPhysicalDevices: 'no',
        },
      }),
    );
    const config = loadWorkerConfig(configPath);
    expect(config.androidAutomation).toEqual({
      enabled: true,
      headlessEmulator: true,
      maxEmulators: 1,
      bootTimeoutMs: 180000,
      allowPhysicalDevices: true,
      injectMaestroMcp: false,
      appiumMcp: false,
    });
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

  it('strips query and fragment data from persisted coordinator URLs', () => {
    const configPath = path.join(tempDir, 'worker-node.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        authToken: 'pair-token',
        coordinatorUrl: 'wss://macbook-pro.tail4fc107.ts.net:4878/worker?token=secret#pairing',
        coordinatorUrls: [
          'ws://fallback.tail4fc107.ts.net:4878/?token=secret#pairing',
          'wss://backup.tail4fc107.ts.net:4879/path?authToken=secret#fragment',
        ],
      }),
    );

    const config = loadWorkerConfig(configPath);
    const persisted = fs.readFileSync(configPath, 'utf-8');

    expect(config.coordinatorUrl).toBe('wss://macbook-pro.tail4fc107.ts.net:4878/worker');
    expect(config.coordinatorUrls).toEqual([
      'ws://fallback.tail4fc107.ts.net:4878',
      'wss://backup.tail4fc107.ts.net:4879/path',
    ]);
    expect(persisted).not.toContain('secret');
    expect(persisted).not.toContain('pairing');
    expect(persisted).not.toContain('fragment');
  });

  it('reports a clear startup error when no coordinator URL can be derived', () => {
    expect(() => assertWorkerConfigHasCoordinator({
      nodeId: 'node-1',
      name: 'worker',
      authToken: 'pair-token',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
      reconnectIntervalMs: 5000,
      heartbeatIntervalMs: 10000,
    })).toThrow(
      'Worker config is missing coordinatorUrl. Paste the full Connection Config or run:\n  aio-worker pair <pairing-link>',
    );
  });

  it('uses the first fallback coordinator URL when no primary is configured', () => {
    const config = {
      nodeId: 'node-1',
      name: 'worker',
      authToken: 'pair-token',
      coordinatorUrls: ['', ' ws://fallback:4878 '],
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
      reconnectIntervalMs: 5000,
      heartbeatIntervalMs: 10000,
    };

    expect(() => assertWorkerConfigHasCoordinator(config)).not.toThrow();
    expect(getConfiguredCoordinatorUrl(config)).toBe('ws://fallback:4878');
  });
});
