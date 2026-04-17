import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface MigrateOptions {
  userConfigPath: string;
  serviceConfigPath: string;
}

export interface MigrateResult {
  migrated: boolean;
  reason?: string;
}

export async function migrateConfigIfNeeded(opts: MigrateOptions): Promise<MigrateResult> {
  try {
    await fs.access(opts.serviceConfigPath);
    return { migrated: false, reason: 'target exists' };
  } catch {
    // target missing — proceed
  }

  try {
    await fs.access(opts.userConfigPath);
  } catch {
    return { migrated: false, reason: 'source missing' };
  }

  await fs.mkdir(path.dirname(opts.serviceConfigPath), { recursive: true });
  const contents = await fs.readFile(opts.userConfigPath);
  await fs.writeFile(opts.serviceConfigPath, contents, { mode: 0o600 });
  return { migrated: true };
}
