import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyWorkerSupportFiles } from './support-files';

describe('copyWorkerSupportFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-support-files-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('copies sibling worker-tools into the versioned service directory', async () => {
    const sourceDir = path.join(tempDir, 'source');
    const destinationDir = path.join(tempDir, 'versioned');
    await fs.mkdir(path.join(sourceDir, 'worker-tools'), { recursive: true });
    await fs.mkdir(destinationDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'worker-agent'), '');
    await fs.writeFile(path.join(sourceDir, 'worker-tools', 'axe-audit.mjs'), 'runner');

    await copyWorkerSupportFiles({
      binaryPath: path.join(sourceDir, 'worker-agent'),
      destinationDir,
    });

    await expect(
      fs.readFile(path.join(destinationDir, 'worker-tools', 'axe-audit.mjs'), 'utf-8'),
    ).resolves.toBe('runner');
  });

  it('does nothing when no sibling worker-tools directory exists', async () => {
    const sourceDir = path.join(tempDir, 'source');
    const destinationDir = path.join(tempDir, 'versioned');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(destinationDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'worker-agent'), '');

    await expect(
      copyWorkerSupportFiles({
        binaryPath: path.join(sourceDir, 'worker-agent'),
        destinationDir,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    { platform: 'win32-x64', executable: 'worker-agent.exe', rtkBinary: 'rtk.exe' },
    { platform: 'darwin-arm64', executable: 'worker-agent', rtkBinary: 'rtk' },
    { platform: 'linux-x64', executable: 'worker-agent', rtkBinary: 'rtk' },
  ])('installs RTK and its hook beside the versioned $platform executable without worker-tools', async ({ platform, executable, rtkBinary }) => {
    const sourceDir = path.join(tempDir, 'sea-package');
    const destinationDir = path.join(tempDir, 'service', 'bin', 'versions', '0.0.0');
    await fs.mkdir(path.join(sourceDir, 'hooks'), { recursive: true });
    await fs.mkdir(path.join(sourceDir, 'rtk', platform), { recursive: true });
    await fs.writeFile(path.join(sourceDir, executable), 'worker fixture');
    await fs.writeFile(path.join(sourceDir, 'hooks', 'rtk-defer-hook.mjs'), 'hook fixture');
    await fs.writeFile(path.join(sourceDir, 'rtk', platform, rtkBinary), 'RTK fixture', { mode: 0o755 });
    await fs.writeFile(path.join(sourceDir, 'rtk', platform, 'LICENSE'), 'license fixture');
    // Reinstalling a version must replace the whole support directory, so an
    // asset removed from the package cannot remain active in the service.
    await fs.mkdir(path.join(destinationDir, 'hooks'), { recursive: true });
    await fs.writeFile(path.join(destinationDir, 'hooks', 'obsolete-hook.mjs'), 'stale');

    await copyWorkerSupportFiles({ binaryPath: path.join(sourceDir, executable), destinationDir });

    await expect(fs.readFile(path.join(destinationDir, 'hooks', 'rtk-defer-hook.mjs'), 'utf8')).resolves.toBe('hook fixture');
    await expect(fs.readFile(path.join(destinationDir, 'rtk', platform, rtkBinary), 'utf8')).resolves.toBe('RTK fixture');
    await expect(fs.readFile(path.join(destinationDir, 'rtk', platform, 'LICENSE'), 'utf8')).resolves.toBe('license fixture');
    await expect(fs.stat(path.join(destinationDir, 'hooks', 'obsolete-hook.mjs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps installing available support files when RTK assets are absent', async () => {
    const sourceDir = path.join(tempDir, 'legacy-package');
    const destinationDir = path.join(tempDir, 'versioned');
    await fs.mkdir(path.join(sourceDir, 'worker-tools'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'worker-tools', 'axe-audit.mjs'), 'runner');

    await copyWorkerSupportFiles({ binaryPath: path.join(sourceDir, 'worker-agent'), destinationDir });

    await expect(fs.readFile(path.join(destinationDir, 'worker-tools', 'axe-audit.mjs'), 'utf8')).resolves.toBe('runner');
    await expect(fs.stat(path.join(destinationDir, 'rtk'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(destinationDir, 'hooks'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves sidecars when reinstalling from the installed version itself', async () => {
    const versionedDir = path.join(tempDir, 'versions', '0.0.0');
    await fs.mkdir(path.join(versionedDir, 'hooks'), { recursive: true });
    await fs.writeFile(path.join(versionedDir, 'hooks', 'rtk-defer-hook.mjs'), 'installed hook');
    await copyWorkerSupportFiles({ binaryPath: path.join(versionedDir, 'worker-agent'), destinationDir: versionedDir });
    await expect(fs.readFile(path.join(versionedDir, 'hooks', 'rtk-defer-hook.mjs'), 'utf8')).resolves.toBe('installed hook');
  });

});
