import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { createServer, Server } from 'http';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginSourceResolver } from './plugin-source-resolver';

const execFileAsync = promisify(execFile);

async function createPluginFixture(root: string, name = 'sample-plugin'): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.codex-plugin'), { recursive: true });
  await fs.writeFile(path.join(dir, 'index.js'), 'module.exports = { hooks: {} };\n');
  await fs.writeFile(
    path.join(dir, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', hooks: ['instance.created'] }, null, 2),
  );
  return dir;
}

async function createZip(sourceDir: string, zipPath: string): Promise<void> {
  await execFileAsync('zip', ['-qr', zipPath, '.'], { cwd: sourceDir });
}

describe('PluginSourceResolver', () => {
  let tempDir: string;
  const cleanupFns: (() => Promise<void>)[] = [];
  let server: Server | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-plugin-source-'));
  });

  afterEach(async () => {
    for (const cleanup of cleanupFns.splice(0, cleanupFns.length)) {
      await cleanup();
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('stages a plugin directory outside the active source path', async () => {
    const fixtureDir = await createPluginFixture(tempDir);
    const resolver = new PluginSourceResolver();

    const resolved = await resolver.resolve({ type: 'directory', value: fixtureDir });
    cleanupFns.push(resolved.cleanup);

    expect(resolved.kind).toBe('directory');
    expect(resolved.stagedPath).not.toBe(fixtureDir);
    await expect(fs.access(path.join(resolved.stagedPath, '.codex-plugin', 'plugin.json'))).resolves.toBeUndefined();
  });

  it('stages a single file source', async () => {
    const sourceFile = path.join(tempDir, 'standalone.js');
    await fs.writeFile(sourceFile, 'module.exports = {};\n');
    const resolver = new PluginSourceResolver();

    const resolved = await resolver.resolve({ type: 'file', value: sourceFile });
    cleanupFns.push(resolved.cleanup);

    expect(resolved.kind).toBe('file');
    await expect(fs.access(path.join(resolved.stagedPath, 'standalone.js'))).resolves.toBeUndefined();
  });

  it('copies an adjacent manifest when staging a single file source', async () => {
    const fixtureDir = await createPluginFixture(tempDir, 'file-plugin');
    const resolver = new PluginSourceResolver();

    const resolved = await resolver.resolve({ type: 'file', value: path.join(fixtureDir, 'index.js') });
    cleanupFns.push(resolved.cleanup);

    expect(resolved.kind).toBe('file');
    await expect(fs.access(path.join(resolved.stagedPath, 'index.js'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(resolved.stagedPath, '.codex-plugin', 'plugin.json'))).resolves.toBeUndefined();
  });

  it('extracts a zip source to a staged directory', async () => {
    const fixtureDir = await createPluginFixture(tempDir, 'zip-plugin');
    const zipPath = path.join(tempDir, 'zip-plugin.zip');
    await createZip(fixtureDir, zipPath);
    const resolver = new PluginSourceResolver();

    const resolved = await resolver.resolve({ type: 'zip', value: zipPath });
    cleanupFns.push(resolved.cleanup);

    expect(resolved.kind).toBe('zip');
    await expect(fs.access(path.join(resolved.stagedPath, '.codex-plugin', 'plugin.json'))).resolves.toBeUndefined();
  });

  it('downloads a URL source and extracts zip content', async () => {
    const fixtureDir = await createPluginFixture(tempDir, 'url-plugin');
    const zipPath = path.join(tempDir, 'url-plugin.zip');
    await createZip(fixtureDir, zipPath);
    const zipBytes = await fs.readFile(zipPath);
    server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/zip');
      res.end(zipBytes);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected server address');
    const resolver = new PluginSourceResolver();

    const resolved = await resolver.resolve({
      type: 'url',
      value: `http://127.0.0.1:${address.port}/url-plugin.zip`,
    });
    cleanupFns.push(resolved.cleanup);

    expect(resolved.kind).toBe('zip');
    await expect(fs.access(path.join(resolved.stagedPath, '.codex-plugin', 'plugin.json'))).resolves.toBeUndefined();
  });
});
