import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { workerBrowserExtensionFolder } from './browser-extension-folder';

describe('workerBrowserExtensionFolder', () => {
  let checkout: string | undefined;

  afterEach(() => {
    if (checkout) fs.rmSync(checkout, { recursive: true, force: true });
  });

  it('finds the extension two levels above the worker code in a checkout', () => {
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-checkout-'));
    const folder = path.join(checkout, 'resources', 'browser-extension');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'manifest.json'), '{}');

    expect(workerBrowserExtensionFolder(path.join(checkout, 'dist', 'worker-agent'))).toBe(folder);
  });

  it('returns undefined for a standalone binary with no extension beside it', () => {
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-binary-'));

    expect(workerBrowserExtensionFolder(path.join(checkout, 'bin', 'aio'))).toBeUndefined();
  });
});
