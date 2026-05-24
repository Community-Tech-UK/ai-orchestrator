import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_EXTENSION_ID,
  BROWSER_EXTENSION_NATIVE_HOST_NAME,
  prepareBrowserExtensionNativeHostRuntime,
} from './browser-extension-native-runtime';

const AIO_MCP = '/Applications/AI Orchestrator.app/Contents/Resources/aio-mcp-cli/aio-mcp';

describe('browser extension native runtime', () => {
  it('writes runtime config + Chrome native-messaging manifest pointing at the aio-mcp SEA wrapper', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-native-runtime-'));
    try {
      const result = prepareBrowserExtensionNativeHostRuntime({
        userDataPath: tempDir,
        socketPath: path.join(tempDir, 'browser.sock'),
        extensionToken: 'native-token',
        aioMcpCliPath: AIO_MCP,
        chromeNativeMessagingDir: path.join(tempDir, 'Chrome', 'NativeMessagingHosts'),
        now: () => 1234,
      });

      expect(JSON.parse(fs.readFileSync(result.runtimeConfigPath, 'utf-8'))).toEqual({
        socketPath: path.join(tempDir, 'browser.sock'),
        extensionToken: 'native-token',
        updatedAt: 1234,
      });
      expect(fs.statSync(result.wrapperPath).mode & 0o111).not.toBe(0);

      const wrapper = fs.readFileSync(result.wrapperPath, 'utf-8');
      // The wrapper should invoke the aio-mcp SEA with the native-host
      // subcommand — no ELECTRON_RUN_AS_NODE indirection any more.
      expect(wrapper).toContain(AIO_MCP);
      expect(wrapper).toContain('native-host');
      expect(wrapper).not.toContain('ELECTRON_RUN_AS_NODE');

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
