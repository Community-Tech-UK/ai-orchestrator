import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Block until the file system's change clock has moved on, so a file changed next gets a later change time (ctime)
 * than anything stamped before this call. Linux kernels without fine-grained timestamps (the WSL computer that runs
 * the test suite) stamp ctime from a clock that ticks every few milliseconds, so a rewrite straight after a scan can
 * keep the scanned ctime and look unchanged; macOS stamps nanoseconds and returns at once. The probe lives in its own
 * temporary folder so the fixture's folders are not touched.
 */
export function waitForChangeClockTick(): void {
  const dir = mkdtempSync(join(tmpdir(), 'change-clock-'));
  const probe = join(dir, 'probe');
  try {
    writeFileSync(probe, 'a');
    const start = lstatSync(probe).ctimeMs;
    const deadline = Date.now() + 1_000;
    for (let flip = 0; lstatSync(probe).ctimeMs <= start; flip++) {
      if (Date.now() > deadline) throw new Error('The file change clock did not move within 1 second');
      writeFileSync(probe, flip % 2 ? 'a' : 'b');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
