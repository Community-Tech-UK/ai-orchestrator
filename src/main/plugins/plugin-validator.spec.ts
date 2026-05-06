import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginDependencyResolver } from './plugin-dependency-resolver';
import { PluginValidator } from './plugin-validator';

async function writePlugin(root: string, manifest: Record<string, unknown>): Promise<string> {
  const dir = path.join(root, String(manifest['name'] ?? 'plugin'));
  await fs.mkdir(path.join(dir, '.codex-plugin'), { recursive: true });
  await fs.writeFile(path.join(dir, 'index.js'), 'module.exports = { hooks: {} };\n');
  await fs.writeFile(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

describe('PluginValidator', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-plugin-validator-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('fails when .codex-plugin/plugin.json is missing', async () => {
    const dir = path.join(tempDir, 'missing-manifest');
    await fs.mkdir(dir, { recursive: true });
    const validator = new PluginValidator(new PluginDependencyResolver(async () => []));

    const result = await validator.validate(dir);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('.codex-plugin/plugin.json');
  });

  it('fails when a required dependency is not installed', async () => {
    const dir = await writePlugin(tempDir, {
      name: 'needs-helper',
      version: '1.0.0',
      dependencies: [{ name: 'helper-plugin' }],
    });
    const validator = new PluginValidator(new PluginDependencyResolver(async () => []));

    const result = await validator.validate(dir);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('helper-plugin');
  });

  it('warns but does not fail when an optional dependency is not installed', async () => {
    const dir = await writePlugin(tempDir, {
      name: 'optional-helper',
      version: '1.0.0',
      dependencies: [{ name: 'helper-plugin', optional: true }],
    });
    const validator = new PluginValidator(new PluginDependencyResolver(async () => []));

    const result = await validator.validate(dir);

    expect(result.ok).toBe(true);
    expect(result.warnings.join('\n')).toContain('helper-plugin');
  });

  it('fails when the supplied checksum does not match', async () => {
    const dir = await writePlugin(tempDir, { name: 'checksum-plugin', version: '1.0.0' });
    const checksumPath = path.join(dir, 'index.js');
    const bytes = await fs.readFile(checksumPath);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const validator = new PluginValidator(new PluginDependencyResolver(async () => []));

    const ok = await validator.validate(dir, { checksumPath, expectedChecksum: `sha256:${digest}` });
    const bad = await validator.validate(dir, { checksumPath, expectedChecksum: 'sha256:bad' });

    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toContain('checksum');
  });
});
