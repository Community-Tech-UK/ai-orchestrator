import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createServer, Server } from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { PluginSourceResolver } from './plugin-source-resolver';

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
  const entries: Record<string, Uint8Array> = {};

  async function walk(dir: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const absolutePath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      const relativePath = path.relative(sourceDir, absolutePath).split(path.sep).join('/');
      entries[relativePath] = new Uint8Array(await fs.readFile(absolutePath));
    }
  }

  await walk(sourceDir);
  await fs.writeFile(zipPath, Buffer.from(zipSync(entries)));
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

  it('refuses a zip whose entry escapes the extraction directory', async () => {
    const zipPath = path.join(tempDir, 'traversal.zip');
    // fflate refuses to encode a `../` entry name, so build the archive with a
    // same-length placeholder and patch the raw bytes. Zip stores the name
    // verbatim in the local and central headers and CRCs only cover the file
    // contents, so a same-length rename keeps the archive valid.
    const patched = Buffer.from(
      zipSync({
        'index.js': new Uint8Array(Buffer.from('module.exports = {};\n')),
        'xx/escaped.txt': new Uint8Array(Buffer.from('pwned\n')),
      }),
    );
    for (let index = patched.indexOf('xx/escaped.txt'); index !== -1; ) {
      patched.write('../escaped.txt', index, 'latin1');
      index = patched.indexOf('xx/escaped.txt', index + 1);
    }
    await fs.writeFile(zipPath, patched);
    const resolver = new PluginSourceResolver();

    // yauzl rejects `../` names before our guard sees them; asserted here so the
    // combined behaviour stays covered if either layer changes.
    await expect(resolver.resolve({ type: 'zip', value: zipPath })).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, 'escaped.txt'))).rejects.toThrow();
  });

  it('refuses a zip containing a symlink entry', async () => {
    // GHSA-jmr9-qjv8-65gv: extract-zip creates symlinks without validating the
    // target, so `link -> /tmp` lets a later `link/...` entry write outside the
    // staging directory. Unix os id (3) + IFLNK mode marks the entry a symlink.
    const zipPath = path.join(tempDir, 'symlink.zip');
    await fs.writeFile(
      zipPath,
      Buffer.from(
        zipSync({
          link: [new Uint8Array(Buffer.from(tempDir)), { os: 3, attrs: 0o120777 * 0x10000 }],
        }),
      ),
    );
    const resolver = new PluginSourceResolver();

    await expect(resolver.resolve({ type: 'zip', value: zipPath })).rejects.toThrow(/symlink/);
  });
});
