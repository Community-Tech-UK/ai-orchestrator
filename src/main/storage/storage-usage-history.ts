import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';

const DAY = 86_400_000;
interface Sample { measuredAt: number; bytes: number }

/** Bounded daily measurements; no extrapolated growth from a partial week. */
export async function recordStorageUsage(root: string, measuredAt: number, bytes: number): Promise<number | null> {
  const file = path.join(root, 'storage-usage-history.json');
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    let samples: Sample[] = [];
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Invalid storage measurement file');
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Array.isArray(parsed)) samples = parsed.filter((row): row is Sample => typeof row?.measuredAt === 'number' && Number.isFinite(row.measuredAt) && typeof row?.bytes === 'number' && Number.isFinite(row.bytes) && row.bytes >= 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    samples = samples.filter(row => row.measuredAt >= measuredAt - 35 * DAY && row.measuredAt <= measuredAt).sort((a, b) => a.measuredAt - b.measuredAt);
    const baseline = samples.filter(row => row.measuredAt <= measuredAt - 7 * DAY && row.measuredAt >= measuredAt - 8 * DAY).at(-1);
    samples = samples.filter(row => Math.floor(row.measuredAt / DAY) !== Math.floor(measuredAt / DAY));
    samples.push({ measuredAt, bytes });
    await fs.writeFile(temporary, JSON.stringify(samples.slice(-36)), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
    return baseline ? bytes - baseline.bytes : null;
  } catch (error) {
    getLogger('StorageUsage').warn('Weekly storage measurement unavailable', { error: String(error) });
    return null;
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}
