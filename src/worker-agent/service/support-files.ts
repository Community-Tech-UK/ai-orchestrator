import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function copyWorkerSupportFiles(input: {
  binaryPath: string;
  destinationDir: string;
}): Promise<void> {
  const sourceToolsDir = path.join(path.dirname(input.binaryPath), 'worker-tools');
  try {
    const stat = await fs.stat(sourceToolsDir);
    if (!stat.isDirectory()) {
      return;
    }
  } catch {
    return;
  }

  const destinationToolsDir = path.join(input.destinationDir, 'worker-tools');
  await fs.rm(destinationToolsDir, { recursive: true, force: true });
  await fs.cp(sourceToolsDir, destinationToolsDir, { recursive: true });
}
