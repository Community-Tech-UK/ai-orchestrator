import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';

const logger = getLogger('WriteSafetyHelper');

export interface WriteSafetyOptions {
  allowWorldWritableParent: boolean;
  writeBackups: boolean;
}

export class WriteSafetyHelper {
  private readonly backedUpPaths = new Set<string>();

  constructor(private options: WriteSafetyOptions) {}

  updateOptions(options: WriteSafetyOptions): void {
    this.options = options;
  }

  async writeAtomic(targetPath: string, contents: string | Buffer): Promise<void> {
    const parent = path.dirname(targetPath);
    await fsp.mkdir(parent, { recursive: true });
    await this.guardParentPermission(targetPath);
    const mode = await this.getTargetMode(targetPath);

    if (this.options.writeBackups && fs.existsSync(targetPath) && !this.backedUpPaths.has(targetPath)) {
      const backupPath = this.backupPath(targetPath);
      await fsp.copyFile(targetPath, backupPath);
      if (mode !== undefined) {
        await fsp.chmod(backupPath, mode).catch(() => undefined);
      }
      this.backedUpPaths.add(targetPath);
    }

    const tmpPath = `${targetPath}.orc.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, contents, mode === undefined ? undefined : { mode });
    if (mode !== undefined) {
      await fsp.chmod(tmpPath, mode).catch(() => undefined);
    }
    try {
      await fsp.rename(tmpPath, targetPath);
    } catch (error) {
      if (process.platform !== 'win32') {
        throw error;
      }
      await fsp.copyFile(tmpPath, targetPath);
      if (mode !== undefined) {
        await fsp.chmod(targetPath, mode).catch(() => undefined);
      }
      await fsp.unlink(tmpPath).catch(() => undefined);
    }
  }

  async cleanupBackups(trackedPaths: readonly string[] = [...this.backedUpPaths]): Promise<void> {
    for (const targetPath of trackedPaths) {
      try {
        await fsp.unlink(this.backupPath(targetPath)).catch(() => undefined);
        this.backedUpPaths.delete(targetPath);
      } catch (error) {
        logger.warn('Failed to clean MCP backup files', {
          path: targetPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async guardParentPermission(targetPath: string): Promise<void> {
    if (this.options.allowWorldWritableParent || process.platform === 'win32') {
      return;
    }
    const parent = path.dirname(targetPath);
    try {
      const stat = await fsp.stat(parent);
      if ((stat.mode & 0o002) !== 0) {
        throw new Error(`Refusing to write MCP config under world-writable parent: ${parent}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  private backupPath(targetPath: string): string {
    return `${targetPath}.orch-bak`;
  }

  private async getTargetMode(targetPath: string): Promise<number | undefined> {
    if (process.platform === 'win32') {
      return undefined;
    }
    try {
      return (await fsp.stat(targetPath)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0o600;
      }
      throw error;
    }
  }
}
