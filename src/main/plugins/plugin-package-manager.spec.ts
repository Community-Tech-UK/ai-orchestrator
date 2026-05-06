import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginPackageManager } from './plugin-package-manager';

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
});
