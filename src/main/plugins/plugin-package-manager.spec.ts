import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginPackageManager, sanitizePluginId } from './plugin-package-manager';

async function writeRuntimePlugin(
  root: string,
  name: string,
  version = '1.0.0',
  extraManifest: Record<string, unknown> = {},
): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.codex-plugin'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'index.js'),
    `module.exports = { hooks: { 'instance.created': () => undefined } };\n`,
  );
  await fs.writeFile(
    path.join(dir, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name, version, hooks: ['instance.created'], ...extraManifest }, null, 2),
  );
  return dir;
}

describe('PluginPackageManager', () => {
  let tempDir: string;
  let sourceRoot: string;
  let pluginRoot: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-plugin-package-manager-'));
    sourceRoot = path.join(tempDir, 'sources');
    pluginRoot = path.join(tempDir, 'active-plugins');
    storePath = path.join(tempDir, 'install-store.json');
    await fs.mkdir(sourceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('installs a validated runtime plugin into the active plugin directory', async () => {
    const source = await writeRuntimePlugin(sourceRoot, 'Example Plugin');
    const manager = new PluginPackageManager({ pluginRoot, storePath });

    const installed = await manager.install({ type: 'directory', value: source });

    expect(installed).toMatchObject({
      id: 'example-plugin',
      name: 'Example Plugin',
      version: '1.0.0',
      status: 'installed',
    });
    await expect(fs.access(path.join(pluginRoot, 'example-plugin', 'index.js'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(pluginRoot, 'example-plugin', '.codex-plugin', 'plugin.json')),
    ).resolves.toBeUndefined();
  });

  it('installs a single-file runtime plugin when a sidecar manifest is present', async () => {
    const source = await writeRuntimePlugin(sourceRoot, 'File Plugin');
    const manager = new PluginPackageManager({ pluginRoot, storePath });

    const installed = await manager.install({ type: 'file', value: path.join(source, 'index.js') });

    expect(installed).toMatchObject({
      id: 'file-plugin',
      name: 'File Plugin',
      version: '1.0.0',
      status: 'installed',
    });
    await expect(fs.access(path.join(pluginRoot, 'file-plugin', 'index.js'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(pluginRoot, 'file-plugin', '.codex-plugin', 'plugin.json')),
    ).resolves.toBeUndefined();
  });

  it('rolls back a failed update and preserves the installed plugin record', async () => {
    const initialSource = await writeRuntimePlugin(sourceRoot, 'Rollback Plugin', '1.0.0');
    const invalidSource = path.join(sourceRoot, 'invalid-plugin');
    await fs.mkdir(invalidSource, { recursive: true });
    await fs.writeFile(path.join(invalidSource, 'index.js'), 'module.exports = {};\n');
    const manager = new PluginPackageManager({ pluginRoot, storePath });
    await manager.install({ type: 'directory', value: initialSource });

    await expect(
      manager.update('rollback-plugin', { type: 'directory', value: invalidSource }),
    ).rejects.toThrow(/plugin\.json/i);

    await expect(fs.access(path.join(pluginRoot, 'rollback-plugin', 'index.js'))).resolves.toBeUndefined();
    await expect(manager.list()).resolves.toContainEqual(expect.objectContaining({
      id: 'rollback-plugin',
      status: 'installed',
      version: '1.0.0',
    }));
  });

  it('updates from the stored source when no replacement source is provided', async () => {
    const source = await writeRuntimePlugin(sourceRoot, 'Stored Source Plugin', '1.0.0');
    const manager = new PluginPackageManager({ pluginRoot, storePath });
    await manager.install({ type: 'directory', value: source });
    await fs.writeFile(
      path.join(source, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'Stored Source Plugin', version: '1.1.0' }, null, 2),
    );

    const updated = await manager.update('stored-source-plugin');

    expect(updated.version).toBe('1.1.0');
    await expect(manager.list()).resolves.toContainEqual(expect.objectContaining({
      id: 'stored-source-plugin',
      version: '1.1.0',
    }));
  });

  it('prunes stale install records whose plugin directory no longer exists', async () => {
    const source = await writeRuntimePlugin(sourceRoot, 'Stale Plugin');
    const manager = new PluginPackageManager({ pluginRoot, storePath });
    await manager.install({ type: 'directory', value: source });
    await fs.rm(path.join(pluginRoot, 'stale-plugin'), { recursive: true, force: true });

    const result = await manager.prune();

    expect(result.removed).toEqual(['stale-plugin']);
    await expect(manager.list()).resolves.not.toContainEqual(expect.objectContaining({ id: 'stale-plugin' }));
  });

  it('prunes disabled and broken active runtime plugin records', async () => {
    const disabledPath = path.join(pluginRoot, 'disabled-plugin');
    const brokenPath = path.join(pluginRoot, 'broken-plugin');
    await fs.mkdir(disabledPath, { recursive: true });
    await fs.mkdir(brokenPath, { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({
      packages: [
        {
          id: 'disabled-plugin',
          name: 'Disabled Plugin',
          version: '1.0.0',
          status: 'disabled',
          source: { type: 'directory', value: disabledPath },
          installPath: disabledPath,
          cachePath: disabledPath,
          lastValidationResult: { ok: true, errors: [], warnings: [] },
          lastUpdatedAt: 1,
        },
        {
          id: 'broken-plugin',
          name: 'Broken Plugin',
          version: '1.0.0',
          status: 'installed',
          source: { type: 'directory', value: brokenPath },
          installPath: brokenPath,
          cachePath: brokenPath,
          lastValidationResult: { ok: true, errors: [], warnings: [] },
          lastUpdatedAt: 1,
        },
      ],
    }, null, 2));
    const manager = new PluginPackageManager({ pluginRoot, storePath });

    await expect(manager.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'broken-plugin', status: 'broken' }),
      expect.objectContaining({ id: 'disabled-plugin', status: 'disabled' }),
    ]));
    const result = await manager.prune();

    expect(result.removed.sort()).toEqual(['broken-plugin', 'disabled-plugin']);
    await expect(manager.list()).resolves.toEqual([]);
    await expect(fs.access(disabledPath)).rejects.toThrow();
    await expect(fs.access(brokenPath)).rejects.toThrow();
  });

  it('rejects plugin ids that resolve to the plugin root or its parent', () => {
    expect(() => sanitizePluginId('.')).toThrow('Plugin name does not produce a safe id');
    expect(() => sanitizePluginId('..')).toThrow('Plugin name does not produce a safe id');
  });

  it('refuses to uninstall a plugin record outside the managed plugin root', async () => {
    const outsidePath = path.join(tempDir, 'outside-plugin');
    await fs.mkdir(outsidePath, { recursive: true });
    await fs.writeFile(path.join(outsidePath, 'sentinel.txt'), 'keep\n', 'utf-8');
    await fs.writeFile(storePath, JSON.stringify({
      packages: [
        {
          id: 'outside-plugin',
          name: 'Outside Plugin',
          version: '1.0.0',
          status: 'installed',
          source: { type: 'directory', value: outsidePath },
          installPath: outsidePath,
          cachePath: outsidePath,
          lastValidationResult: { ok: true, errors: [], warnings: [] },
          lastUpdatedAt: 1,
        },
      ],
    }, null, 2));
    const manager = new PluginPackageManager({ pluginRoot, storePath });

    await expect(manager.uninstall('outside-plugin')).rejects.toThrow(/outside managed plugin root/i);

    await expect(fs.access(path.join(outsidePath, 'sentinel.txt'))).resolves.toBeUndefined();
  });
});
