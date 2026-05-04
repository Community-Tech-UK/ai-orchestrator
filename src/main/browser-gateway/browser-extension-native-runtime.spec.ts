import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_EXTENSION_ID,
  BROWSER_EXTENSION_NATIVE_HOST_NAME,
  prepareBrowserExtensionNativeHostRuntime,
} from './browser-extension-native-runtime';

describe('browser extension native runtime', () => {
  it('writes runtime config, executable host wrapper, and Chrome native messaging manifest', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-native-runtime-'));
    try {
      const result = prepareBrowserExtensionNativeHostRuntime({
        userDataPath: tempDir,
        socketPath: path.join(tempDir, 'browser.sock'),
        extensionToken: 'native-token',
        electronPath: '/Applications/AI Orchestrator.app/Contents/MacOS/AI Orchestrator',
        nativeHostScriptPath: '/Applications/AI Orchestrator.app/Contents/Resources/app/dist/main/browser-gateway/browser-extension-native-host.js',
        chromeNativeMessagingDir: path.join(tempDir, 'Chrome', 'NativeMessagingHosts'),
        now: () => 1234,
      });

      expect(JSON.parse(fs.readFileSync(result.runtimeConfigPath, 'utf-8'))).toEqual({
        socketPath: path.join(tempDir, 'browser.sock'),
        extensionToken: 'native-token',
        updatedAt: 1234,
      });
      expect(fs.statSync(result.wrapperPath).mode & 0o111).not.toBe(0);
      expect(fs.readFileSync(result.wrapperPath, 'utf-8')).toContain('ELECTRON_RUN_AS_NODE=1');

      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf-8'));
      expect(manifest).toMatchObject({
        name: BROWSER_EXTENSION_NATIVE_HOST_NAME,
        type: 'stdio',
        path: result.wrapperPath,
        allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`],
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
