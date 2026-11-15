import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExtensionRelayNativeRegistration } from './extension-relay-native-registration';
import { DEFAULT_WORKER_HOME, workerRelayHostName } from './worker-home';

describe('two worker native links', () => {
  it('registers the second worker without changing the first worker link', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-native-links-'));
    const chromeNativeMessagingDir = path.join(folder, 'Chrome', 'NativeMessagingHosts');
    const registry = { readManifestPath: () => undefined, registerHost: () => true, unregisterHost: () => true };
    try {
      const register = (name: string, hostName: string) => new ExtensionRelayNativeRegistration({
        userDataPath: path.join(folder, name), hostName, chromeNativeMessagingDir, registry,
        hostCommand: { exe: path.join(folder, name, 'node'), args: ['native-host'] },
        logger: { info: () => undefined, warn: () => undefined },
      }).checkAndRepair({ enabled: true, socketPath: path.join(folder, name, 'relay.sock'), extensionToken: 'placeholder' });
      const first = register('first', workerRelayHostName(DEFAULT_WORKER_HOME));
      expect(first.registration).toBe('repaired');
      const original = fs.readFileSync(first.manifestPath!, 'utf-8');
      const second = register('second', workerRelayHostName(path.join(folder, 'second')));
      expect(second.registration).toBe('repaired');
      expect(second.manifestPath).not.toBe(first.manifestPath);
      expect(fs.readFileSync(first.manifestPath!, 'utf-8')).toBe(original);
      const a = JSON.parse(original) as { allowed_origins: string[] };
      const b = JSON.parse(fs.readFileSync(second.manifestPath!, 'utf-8')) as { allowed_origins: string[] };
      expect(b.allowed_origins).toEqual(a.allowed_origins);
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  });
});
