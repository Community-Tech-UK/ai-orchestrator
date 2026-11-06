import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function copyWorkerSupportFiles(input: {
  binaryPath: string;
  destinationDir: string;
}): Promise<void> {
  // These sidecars must remain beside the installed binary, including when
  // the service starts outside the checkout or switches its current version.
  for (const directory of ['worker-tools', 'hooks', 'rtk']) {
    const sourceDir = path.join(path.dirname(input.binaryPath), directory);
    try {
      if (!(await fs.stat(sourceDir)).isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    const destinationDir = path.join(input.destinationDir, directory);
    try {
      // current may be a symlink/junction to the very version being installed.
      if (await fs.realpath(sourceDir) === await fs.realpath(destinationDir)) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.rm(destinationDir, { recursive: true, force: true });
    await fs.cp(sourceDir, destinationDir, { recursive: true });
  }
}
