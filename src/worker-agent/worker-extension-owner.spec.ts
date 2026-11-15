import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkerExtensionRelay } from './worker-extension-relay';

describe('extension version owner', () => {
  it('lets the second worker relay commands without reloading the shared extension', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-owner-'));
    const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\aio-owner-${process.pid}-${Date.now()}` : path.join(folder, 'relay.sock');
    const relay = new WorkerExtensionRelay({
      config: { enabled: true, socketPath, extensionToken: 'placeholder' },
      sendRequest: async () => null,
      expectedExtensionVersion: '9.0.0',
      ownsExtension: false,
    });
    try {
      await relay.start();
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const client = net.createConnection(socketPath);
        let text = '';
        client.on('error', reject);
        client.on('connect', () => client.write(JSON.stringify({ id: 1, method: 'browser.extension_poll_command', params: { extensionToken: 'placeholder', payload: {} } }) + '\n'));
        client.on('data', chunk => { text += chunk.toString(); });
        client.on('end', () => resolve(JSON.parse(text)));
      });
      expect(result['result']).toBeNull();
      expect(result).not.toHaveProperty('expectedExtensionVersion');
    } finally {
      await relay.stop();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
