import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import extractZip from 'extract-zip';
import type { PluginPackageSource } from '@contracts/schemas/plugin';
export type { PluginPackageSource } from '@contracts/schemas/plugin';

export interface ResolvedPluginSource {
  kind: 'file' | 'directory' | 'zip';
  source: PluginPackageSource;
  stagedPath: string;
  checksumPath?: string;
  cleanup: () => Promise<void>;
}

export class PluginSourceResolver {
  async resolve(source: PluginPackageSource): Promise<ResolvedPluginSource> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-plugin-'));
    const cleanup = async () => {
      await fs.rm(root, { recursive: true, force: true });
    };

    try {
      if (source.type === 'directory') {
        const stagedPath = path.join(root, path.basename(source.value));
        await fs.cp(source.value, stagedPath, { recursive: true });
        return { kind: 'directory', source, stagedPath, cleanup };
      }

      if (source.type === 'file') {
        const stagedPath = path.join(root, 'plugin');
        await fs.mkdir(stagedPath, { recursive: true });
        const target = path.join(stagedPath, path.basename(source.value));
        await fs.copyFile(source.value, target);
        await this.copySidecarManifest(source.value, stagedPath);
        return { kind: 'file', source, stagedPath, checksumPath: target, cleanup };
      }

      if (source.type === 'zip') {
        return await this.extractZipSource(source, source.value, root, cleanup);
      }

      const downloaded = await this.download(source.value, root);
      if (this.isZip(downloaded.filePath, downloaded.contentType)) {
        return await this.extractZipSource(source, downloaded.filePath, root, cleanup);
      }

      const stagedPath = path.join(root, 'plugin');
      await fs.mkdir(stagedPath, { recursive: true });
      const target = path.join(stagedPath, path.basename(downloaded.filePath));
      await fs.copyFile(downloaded.filePath, target);
      return { kind: 'file', source, stagedPath, checksumPath: target, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  private async extractZipSource(
    source: PluginPackageSource,
    zipPath: string,
    root: string,
    cleanup: () => Promise<void>,
  ): Promise<ResolvedPluginSource> {
    const stagedPath = path.join(root, 'plugin');
    await fs.mkdir(stagedPath, { recursive: true });
    await extractZip(zipPath, { dir: stagedPath });
    return { kind: 'zip', source, stagedPath, checksumPath: zipPath, cleanup };
  }

  private async download(url: string, root: string): Promise<{ filePath: string; contentType: string }> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download plugin source: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const extension = contentType.includes('zip') || url.toLowerCase().endsWith('.zip') ? '.zip' : '.js';
    const filePath = path.join(root, `download${extension}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(filePath, bytes);
    return { filePath, contentType };
  }

  private isZip(filePath: string, contentType: string): boolean {
    return contentType.includes('zip') || filePath.toLowerCase().endsWith('.zip');
  }

  private async copySidecarManifest(sourceFile: string, stagedPath: string): Promise<void> {
    const sourceDir = path.dirname(sourceFile);
    const candidates = [
      path.join(sourceDir, '.codex-plugin', 'plugin.json'),
      path.join(sourceDir, 'plugin.json'),
    ];

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw error;
      }

      const targetDir = path.join(stagedPath, '.codex-plugin');
      await fs.mkdir(targetDir, { recursive: true });
      await fs.copyFile(candidate, path.join(targetDir, 'plugin.json'));
      return;
    }
  }
}
