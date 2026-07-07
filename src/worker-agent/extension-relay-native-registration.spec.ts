import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_EXTENSION_NATIVE_HOST_NAME,
  BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
  browserExtensionNativeHostManifestPath,
  browserExtensionNativeHostPaths,
} from '../main/browser-gateway/browser-extension-native-runtime';
import {
  ExtensionRelayNativeRegistration,
  prepareLegacyExtensionRelayNativeHostRuntime,
} from './extension-relay-native-registration';

const AIO_MCP = '/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp';
const originalPlatform = process.platform;

describe('ExtensionRelayNativeRegistration', () => {
  let scratchRoot: string;
  let now: number;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    scratchRoot = fs.mkdtempSync(path.join(process.cwd(), '_scratch', 'relay-registration-'));
    now = 1_000;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it('repairs only the relay native-host registration and reports it in the summary', () => {
    const registry = makeRegistry();
    const logger = makeLogger();
    const manager = new ExtensionRelayNativeRegistration({
      userDataPath: path.join(scratchRoot, 'worker'),
      chromeNativeMessagingDir: path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts'),
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      registry,
      logger,
      now: () => now,
    });

    const summary = manager.checkAndRepair({
      enabled: true,
      socketPath: path.join(scratchRoot, 'relay.sock'),
      extensionToken: 'extension-token',
      legacyNameRegistration: true,
    });

    expect(summary).toMatchObject({
      registration: 'repaired',
      lastRegistrationCheckAt: now,
    });
    expect(registry.registerHost).toHaveBeenCalledWith(
      BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
      browserExtensionNativeHostManifestPath(
        path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts'),
        BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
      ),
    );
    expect(registry.registerHost).not.toHaveBeenCalledWith(
      BROWSER_EXTENSION_NATIVE_HOST_NAME,
      expect.any(String),
    );
    expect(fs.existsSync(browserExtensionNativeHostManifestPath(
      path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts'),
      BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
    ))).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns ok without rewriting when registry, manifest, and wrapper already match', () => {
    const registry = makeRegistry();
    const logger = makeLogger();
    const chromeNativeMessagingDir = path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts');
    const manager = new ExtensionRelayNativeRegistration({
      userDataPath: path.join(scratchRoot, 'worker'),
      chromeNativeMessagingDir,
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      registry,
      logger,
      now: () => now,
    });
    const config = {
      enabled: true,
      socketPath: path.join(scratchRoot, 'relay.sock'),
      extensionToken: 'extension-token',
      legacyNameRegistration: true,
    };

    const first = manager.checkAndRepair(config);
    registry.registerHost.mockClear();
    registry.readManifestPath.mockReturnValue(first.manifestPath);
    now += 1_000;

    const second = manager.checkAndRepair(config);

    expect(second.registration).toBe('ok');
    expect(second.lastRegistrationCheckAt).toBe(now);
    expect(registry.registerHost).not.toHaveBeenCalled();
  });

  it('repairs stale runtime config when the relay socket or token changes', () => {
    const registry = makeRegistry();
    const logger = makeLogger();
    const userDataPath = path.join(scratchRoot, 'worker');
    const chromeNativeMessagingDir = path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts');
    const manager = new ExtensionRelayNativeRegistration({
      userDataPath,
      chromeNativeMessagingDir,
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      registry,
      logger,
      now: () => now,
    });
    const originalConfig = {
      enabled: true,
      socketPath: path.join(scratchRoot, 'old-relay.sock'),
      extensionToken: 'old-extension-token',
      legacyNameRegistration: true,
    };
    const updatedConfig = {
      enabled: true,
      socketPath: path.join(scratchRoot, 'new-relay.sock'),
      extensionToken: 'new-extension-token',
      legacyNameRegistration: true,
    };

    const first = manager.checkAndRepair(originalConfig);
    registry.registerHost.mockClear();
    registry.readManifestPath.mockReturnValue(first.manifestPath);
    now += 1_000;

    const second = manager.checkAndRepair(updatedConfig);
    const runtimeConfigPath = browserExtensionNativeHostPaths({
      userDataPath,
      chromeNativeMessagingDir,
      hostName: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
    }).runtimeConfigPath;

    expect(second.registration).toBe('repaired');
    expect(registry.registerHost).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf-8'))).toMatchObject({
      socketPath: updatedConfig.socketPath,
      extensionToken: updatedConfig.extensionToken,
    });
  });

  it('repairs a corrupt relay manifest instead of staying in error state', () => {
    const registry = makeRegistry();
    const chromeNativeMessagingDir = path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts');
    const manifestPath = browserExtensionNativeHostManifestPath(
      chromeNativeMessagingDir,
      BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
    );
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, '{not-json', 'utf-8');
    registry.readManifestPath.mockReturnValue(manifestPath);
    const manager = new ExtensionRelayNativeRegistration({
      userDataPath: path.join(scratchRoot, 'worker'),
      chromeNativeMessagingDir,
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      registry,
      logger: makeLogger(),
      now: () => now,
    });

    const summary = manager.checkAndRepair({
      enabled: true,
      socketPath: path.join(scratchRoot, 'relay.sock'),
      extensionToken: 'extension-token',
      legacyNameRegistration: true,
    });

    expect(summary.registration).toBe('repaired');
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))).toMatchObject({
      name: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
    });
  });

  it('does not overwrite a relay manifest owned outside the worker native directory', () => {
    const registry = makeRegistry();
    const logger = makeLogger();
    const chromeNativeMessagingDir = path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts');
    const manifestPath = browserExtensionNativeHostManifestPath(
      chromeNativeMessagingDir,
      BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
    );
    const foreignWrapperPath = path.join(scratchRoot, 'foreign-owner', 'host.cmd');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(path.dirname(foreignWrapperPath), { recursive: true });
    fs.writeFileSync(foreignWrapperPath, '@echo off\n', 'utf-8');
    const foreignManifest = {
      name: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
      description: 'Foreign relay owner',
      path: foreignWrapperPath,
      type: 'stdio',
      allowed_origins: [],
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(foreignManifest, null, 2)}\n`, 'utf-8');
    registry.readManifestPath.mockReturnValue(manifestPath);
    const manager = new ExtensionRelayNativeRegistration({
      userDataPath: path.join(scratchRoot, 'worker'),
      chromeNativeMessagingDir,
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      registry,
      logger,
      now: () => now,
    });

    const summary = manager.checkAndRepair({
      enabled: true,
      socketPath: path.join(scratchRoot, 'relay.sock'),
      extensionToken: 'extension-token',
      legacyNameRegistration: true,
    });

    expect(summary).toMatchObject({
      registration: 'contested',
      registrationError: 'foreign_relay_manifest',
    });
    expect(registry.registerHost).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))).toEqual(foreignManifest);
    expect(logger.warn).toHaveBeenCalledWith(
      '[WorkerExtensionRelay] Native-host registration contested',
      expect.objectContaining({
        hostName: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
        manifestPath,
      }),
    );
  });

  it('repairs a registry-targeted foreign relay manifest without modifying that foreign file', () => {
    const registry = makeRegistry();
    const logger = makeLogger();
    const chromeNativeMessagingDir = path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts');
    const expectedManifestPath = browserExtensionNativeHostManifestPath(
      chromeNativeMessagingDir,
      BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
    );
    const foreignManifestPath = path.join(scratchRoot, 'foreign-owner', 'relay-manifest.json');
    const foreignWrapperPath = path.join(scratchRoot, 'foreign-owner', 'host.cmd');
    fs.mkdirSync(path.dirname(foreignManifestPath), { recursive: true });
    fs.writeFileSync(foreignWrapperPath, '@echo off\n', 'utf-8');
    fs.writeFileSync(foreignManifestPath, `${JSON.stringify({
      name: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
      description: 'Foreign relay owner',
      path: foreignWrapperPath,
      type: 'stdio',
      allowed_origins: [],
    }, null, 2)}\n`, 'utf-8');
    registry.readManifestPath.mockReturnValue(foreignManifestPath);
    const manager = new ExtensionRelayNativeRegistration({
      userDataPath: path.join(scratchRoot, 'worker'),
      chromeNativeMessagingDir,
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      registry,
      logger,
      now: () => now,
    });

    const summary = manager.checkAndRepair({
      enabled: true,
      socketPath: path.join(scratchRoot, 'relay.sock'),
      extensionToken: 'extension-token',
      legacyNameRegistration: true,
    });

    expect(summary).toMatchObject({
      registration: 'repaired',
    });
    expect(registry.registerHost).toHaveBeenCalledWith(
      BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
      expectedManifestPath,
    );
    expect(JSON.parse(fs.readFileSync(expectedManifestPath, 'utf-8'))).toMatchObject({
      name: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
    });
    expect(JSON.parse(fs.readFileSync(foreignManifestPath, 'utf-8'))).toMatchObject({
      path: foreignWrapperPath,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports registration errors when the Windows registry write fails', () => {
    const registry = makeRegistry();
    registry.registerHost.mockReturnValue(false);
    const logger = makeLogger();
    const manager = new ExtensionRelayNativeRegistration({
      userDataPath: path.join(scratchRoot, 'worker'),
      chromeNativeMessagingDir: path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts'),
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      registry,
      logger,
      now: () => now,
    });

    const summary = manager.checkAndRepair({
      enabled: true,
      socketPath: path.join(scratchRoot, 'relay.sock'),
      extensionToken: 'extension-token',
      legacyNameRegistration: true,
    });

    expect(summary).toMatchObject({
      registration: 'error',
      registrationError: `windows_native_messaging_registration_failed:${BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME}`,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[WorkerExtensionRelay] Native-host registration check failed',
      expect.objectContaining({
        hostName: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
        error: `windows_native_messaging_registration_failed:${BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME}`,
      }),
    );
  });

  it('marks registry flapping to a foreign manifest contested after repeated repairs without log spam', () => {
    const registry = makeRegistry();
    const logger = makeLogger();
    const chromeNativeMessagingDir = path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts');
    const expectedManifestPath = browserExtensionNativeHostManifestPath(
      chromeNativeMessagingDir,
      BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
    );
    const foreignManifestPath = path.join(scratchRoot, 'foreign-owner', 'relay-manifest.json');
    const foreignWrapperPath = path.join(scratchRoot, 'foreign-owner', 'host.cmd');
    fs.mkdirSync(path.dirname(foreignManifestPath), { recursive: true });
    fs.writeFileSync(foreignWrapperPath, '@echo off\n', 'utf-8');
    fs.writeFileSync(foreignManifestPath, `${JSON.stringify({
      name: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
      description: 'Foreign relay owner',
      path: foreignWrapperPath,
      type: 'stdio',
      allowed_origins: [],
    }, null, 2)}\n`, 'utf-8');
    registry.readManifestPath.mockReturnValue(foreignManifestPath);
    const manager = new ExtensionRelayNativeRegistration({
      userDataPath: path.join(scratchRoot, 'worker'),
      chromeNativeMessagingDir,
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      registry,
      logger,
      now: () => now,
    });
    const config = {
      enabled: true,
      socketPath: path.join(scratchRoot, 'relay.sock'),
      extensionToken: 'extension-token',
      legacyNameRegistration: true,
    };

    expect(manager.checkAndRepair(config).registration).toBe('repaired');
    now += 60_000;
    expect(manager.checkAndRepair(config).registration).toBe('repaired');
    now += 60_000;
    expect(manager.checkAndRepair(config).registration).toBe('repaired');
    now += 60_000;
    expect(manager.checkAndRepair(config).registration).toBe('contested');
    now += 60_000;
    expect(manager.checkAndRepair(config).registration).toBe('contested');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('contested');
    expect(registry.registerHost).toHaveBeenCalledTimes(5);
    expect(registry.registerHost).toHaveBeenCalledWith(
      BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
      expectedManifestPath,
    );
    expect(registry.registerHost).not.toHaveBeenCalledWith(
      BROWSER_EXTENSION_NATIVE_HOST_NAME,
      expect.any(String),
    );
    expect(JSON.parse(fs.readFileSync(foreignManifestPath, 'utf-8'))).toMatchObject({
      path: foreignWrapperPath,
    });
  });

  describe('prepareLegacyExtensionRelayNativeHostRuntime', () => {
    it('takes over a DEAD foreign manifest whose wrapper is gone', () => {
      const chromeDir = path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts');
      const manifestPath = browserExtensionNativeHostManifestPath(
        chromeDir,
        BROWSER_EXTENSION_NATIVE_HOST_NAME,
      );
      fs.mkdirSync(chromeDir, { recursive: true });
      fs.writeFileSync(manifestPath, JSON.stringify({
        name: BROWSER_EXTENSION_NATIVE_HOST_NAME,
        path: path.join(scratchRoot, 'harness-app', 'gone.cmd'),
        type: 'stdio',
      }));
      const logger = makeLogger();

      prepareLegacyExtensionRelayNativeHostRuntime({
        userDataPath: path.join(scratchRoot, 'worker'),
        socketPath: path.join(scratchRoot, 'relay.sock'),
        extensionToken: 'extension-token',
        hostCommand: { exe: AIO_MCP, args: ['native-host'] },
        chromeNativeMessagingDir: chromeDir,
        logger,
      });

      const rewritten = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { path: string };
      expect(rewritten.path).toContain(path.join('worker', 'browser-gateway', 'native-host'));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Taking over DEAD foreign'),
        expect.objectContaining({ reason: 'wrapper_missing' }),
      );
    });

    it('takes over a foreign manifest whose runtime targets a dead socket (windows-pc incident)', () => {
      const chromeDir = path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts');
      const manifestPath = browserExtensionNativeHostManifestPath(
        chromeDir,
        BROWSER_EXTENSION_NATIVE_HOST_NAME,
      );
      const foreignDir = path.join(scratchRoot, 'harness-app');
      const foreignWrapper = path.join(foreignDir, 'ai-orchestrator-browser-host.cmd');
      const foreignRuntime = path.join(foreignDir, 'runtime.json');
      fs.mkdirSync(foreignDir, { recursive: true });
      fs.writeFileSync(foreignWrapper, [
        '@echo off',
        `set AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG=${foreignRuntime}`,
        '"node" "host.js" %*',
        '',
      ].join('\r\n'));
      fs.writeFileSync(foreignRuntime, JSON.stringify({
        socketPath: path.join(scratchRoot, 'no-longer-listening.pipe'),
        extensionToken: 'stale-token',
        updatedAt: 1,
      }));
      fs.mkdirSync(chromeDir, { recursive: true });
      fs.writeFileSync(manifestPath, JSON.stringify({
        name: BROWSER_EXTENSION_NATIVE_HOST_NAME,
        path: foreignWrapper,
        type: 'stdio',
      }));
      const logger = makeLogger();

      prepareLegacyExtensionRelayNativeHostRuntime({
        userDataPath: path.join(scratchRoot, 'worker'),
        socketPath: path.join(scratchRoot, 'relay.sock'),
        extensionToken: 'extension-token',
        hostCommand: { exe: AIO_MCP, args: ['native-host'] },
        chromeNativeMessagingDir: chromeDir,
        logger,
      });

      const rewritten = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { path: string };
      expect(rewritten.path).toContain(path.join('worker', 'browser-gateway', 'native-host'));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Taking over DEAD foreign'),
        expect.objectContaining({ reason: 'socket_missing', ownerPath: foreignWrapper }),
      );
    });

    it('leaves a LIVE foreign manifest alone and warns only once across cycles', () => {
      const chromeDir = path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts');
      const manifestPath = browserExtensionNativeHostManifestPath(
        chromeDir,
        BROWSER_EXTENSION_NATIVE_HOST_NAME,
      );
      const foreignDir = path.join(scratchRoot, 'harness-app');
      const foreignWrapper = path.join(foreignDir, 'ai-orchestrator-browser-host.cmd');
      const foreignRuntime = path.join(foreignDir, 'runtime.json');
      const liveSocket = path.join(foreignDir, 'live.sock');
      fs.mkdirSync(foreignDir, { recursive: true });
      fs.writeFileSync(foreignWrapper, [
        '@echo off',
        `set AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG=${foreignRuntime}`,
        '"node" "host.js" %*',
        '',
      ].join('\r\n'));
      fs.writeFileSync(foreignRuntime, JSON.stringify({
        socketPath: liveSocket,
        extensionToken: 'live-token',
        updatedAt: 1,
      }));
      fs.writeFileSync(liveSocket, ''); // stands in for a listening socket
      fs.mkdirSync(chromeDir, { recursive: true });
      const foreignManifest = JSON.stringify({
        name: BROWSER_EXTENSION_NATIVE_HOST_NAME,
        path: foreignWrapper,
        type: 'stdio',
      });
      fs.writeFileSync(manifestPath, foreignManifest);
      const logger = makeLogger();
      const warnedFailures = new Set<string>();

      for (let cycle = 0; cycle < 3; cycle += 1) {
        prepareLegacyExtensionRelayNativeHostRuntime({
          userDataPath: path.join(scratchRoot, 'worker'),
          socketPath: path.join(scratchRoot, 'relay.sock'),
          extensionToken: 'extension-token',
          hostCommand: { exe: AIO_MCP, args: ['native-host'] },
          chromeNativeMessagingDir: chromeDir,
          logger,
          warnedFailures,
        });
      }

      expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(foreignManifest);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Leaving live foreign'),
        expect.objectContaining({ reason: 'socket_present' }),
      );
    });

    it('treats an unrecognized foreign wrapper as alive (never takes over what it cannot judge)', () => {
      const chromeDir = path.join(scratchRoot, 'Chrome', 'NativeMessagingHosts');
      const manifestPath = browserExtensionNativeHostManifestPath(
        chromeDir,
        BROWSER_EXTENSION_NATIVE_HOST_NAME,
      );
      const foreignWrapper = path.join(scratchRoot, 'other-vendor', 'host.sh');
      fs.mkdirSync(path.dirname(foreignWrapper), { recursive: true });
      fs.writeFileSync(foreignWrapper, '#!/bin/sh\nexec /usr/bin/other-host "$@"\n');
      fs.mkdirSync(chromeDir, { recursive: true });
      const foreignManifest = JSON.stringify({
        name: BROWSER_EXTENSION_NATIVE_HOST_NAME,
        path: foreignWrapper,
        type: 'stdio',
      });
      fs.writeFileSync(manifestPath, foreignManifest);
      const logger = makeLogger();

      prepareLegacyExtensionRelayNativeHostRuntime({
        userDataPath: path.join(scratchRoot, 'worker'),
        socketPath: path.join(scratchRoot, 'relay.sock'),
        extensionToken: 'extension-token',
        hostCommand: { exe: AIO_MCP, args: ['native-host'] },
        chromeNativeMessagingDir: chromeDir,
        logger,
      });

      expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(foreignManifest);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Leaving live foreign'),
        expect.objectContaining({ reason: 'wrapper_unrecognized' }),
      );
    });
  });

  function makeRegistry() {
    return {
      readManifestPath: vi.fn(() => undefined as string | undefined),
      registerHost: vi.fn(() => true),
      unregisterHost: vi.fn(() => true),
    };
  }

  function makeLogger() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
    };
  }
});
