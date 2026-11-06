import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { PluginWorkerHost } from './plugin-worker-host';

describe('provider slot readiness', () => {
  it('refuses a provider slot that returns an object without registering an adapter', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'provider-readiness-'));
    const filePath = path.join(dir, 'provider.cjs');
    const host = new PluginWorkerHost({
      filePath, requestedSlot: 'provider', context: { appPath: dir, homeDir: dir },
    });
    try {
      await writeFile(filePath, 'module.exports = { create: () => ({}) };');
      await expect(host.start()).rejects.toThrow('must register at least one provider adapter');
    } finally {
      await host.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
