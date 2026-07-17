import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  _resetCopilotSdkLoaderForTesting,
  findCopilotPackageRoot,
  loadCopilotSdk,
} from './copilot-sdk-loader';

/** Build a fake installed @github/copilot tree and return the bin path. */
function makeFakeInstall(root: string, opts: { withSdk?: boolean; sdkBody?: string } = {}): string {
  const pkgRoot = path.join(root, 'lib', 'node_modules', '@github', 'copilot');
  fs.mkdirSync(pkgRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: '@github/copilot', version: '1.0.99' }),
  );
  fs.writeFileSync(path.join(pkgRoot, 'npm-loader.js'), '// fake loader\n');
  if (opts.withSdk !== false) {
    const sdkDir = path.join(pkgRoot, 'copilot-sdk');
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(
      path.join(sdkDir, 'index.js'),
      opts.sdkBody ?? 'class CopilotClient {}\nmodule.exports = { CopilotClient };\n',
    );
  }
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'copilot');
  fs.symlinkSync(path.join(pkgRoot, 'npm-loader.js'), bin);
  return bin;
}

describe('copilot-sdk-loader', () => {
  let tempRoot: string;

  beforeEach(() => {
    _resetCopilotSdkLoaderForTesting();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-copilot-sdk-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('loads the bundled SDK by following the bin symlink into the package tree', () => {
    const bin = makeFakeInstall(tempRoot);
    const loaded = loadCopilotSdk({ command: bin, argsPrefix: [] });

    expect(loaded).not.toBeNull();
    expect(typeof loaded!.CopilotClient).toBe('function');
    expect(loaded!.packageVersion).toBe('1.0.99');
    expect(loaded!.sdkPath.endsWith(path.join('copilot-sdk', 'index.js'))).toBe(true);
  });

  it('returns null for the gh-wrapper launch (no bundled SDK there)', () => {
    const bin = makeFakeInstall(tempRoot);
    expect(loadCopilotSdk({ command: bin, argsPrefix: ['copilot', '--'] })).toBeNull();
  });

  it('returns null when the CLI package has no bundled SDK (older CLI)', () => {
    const bin = makeFakeInstall(tempRoot, { withSdk: false });
    expect(loadCopilotSdk({ command: bin, argsPrefix: [] })).toBeNull();
  });

  it('returns null when the bundle does not export a CopilotClient constructor', () => {
    const bin = makeFakeInstall(tempRoot, { sdkBody: 'module.exports = {};\n' });
    expect(loadCopilotSdk({ command: bin, argsPrefix: [] })).toBeNull();
  });

  it('returns null for a relative/bare command (nothing resolved on PATH)', () => {
    expect(loadCopilotSdk({ command: 'copilot', argsPrefix: [] })).toBeNull();
  });

  it('caches the result until reset (both hit and miss)', () => {
    const bin = makeFakeInstall(tempRoot);
    const first = loadCopilotSdk({ command: bin, argsPrefix: [] });
    // Different (invalid) launch — cached result still returned.
    const second = loadCopilotSdk({ command: 'copilot', argsPrefix: [] });
    expect(second).toBe(first);

    _resetCopilotSdkLoaderForTesting();
    expect(loadCopilotSdk({ command: 'copilot', argsPrefix: [] })).toBeNull();
  });

  it('findCopilotPackageRoot walks up to the package root and rejects foreign trees', () => {
    const bin = makeFakeInstall(tempRoot);
    const real = fs.realpathSync(bin);
    expect(findCopilotPackageRoot(real)).toBe(
      fs.realpathSync(path.join(tempRoot, 'lib', 'node_modules', '@github', 'copilot')),
    );
    const foreign = path.join(tempRoot, 'somewhere', 'else', 'tool.js');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, '');
    expect(findCopilotPackageRoot(foreign)).toBeNull();
  });
});
