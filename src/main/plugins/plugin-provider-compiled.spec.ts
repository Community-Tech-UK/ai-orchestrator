import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Run after build:main. Source-only tests cannot detect the CommonJS transform. */
describe('compiled installed provider session', () => {
  it.each(['cjs', 'mjs'])('activates, answers and cleans up a %s package using shipped runtime modules', async (extension) => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.resolve('src/tests/fixtures/plugin-provider-compiled.cjs'), extension,
    ], { cwd: process.cwd(), timeout: 60000 });
    expect(JSON.parse(stdout.trim())).toEqual({
      installed: 'installed', lifecycle: 'active', reply: 'Proof response: hello',
      normalSessionAccepted: false, sourceFreeWorker: true, invalidPackageRejected: true, survivedCacheRefresh: true, cleaned: true,
    });
  }, 65000);

  it.skipIf(process.platform !== 'darwin')('loads the SDK and helper inside an Electron application archive', async () => {
    const electron = createRequire(import.meta.url)('electron') as string;
    const { stdout } = await promisify(execFile)(electron, [
      path.resolve('src/tests/fixtures/plugin-provider-compiled.cjs'), 'cjs', 'asar',
    ], { cwd: process.cwd(), timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    expect(JSON.parse(stdout.trim())).toMatchObject({
      lifecycle: 'active', reply: 'Proof response: hello', sourceFreeWorker: true,
      survivedCacheRefresh: true, invalidPackageRejected: true, cleaned: true,
    });
  }, 65000);
});
