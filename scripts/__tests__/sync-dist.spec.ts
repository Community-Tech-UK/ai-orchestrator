import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(specDirectory, '../..');
const scriptPath = resolve(repoRoot, 'scripts/sync-dist.js');

describe('sync-dist script', () => {
  it('copies worker-agent runtime dependencies to the top-level dist layout', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sync-dist-'));
    const tempScriptDir = join(tempRoot, 'scripts');
    mkdirSync(tempScriptDir, { recursive: true });
    cpSync(scriptPath, join(tempScriptDir, 'sync-dist.js'));

    const distRoot = join(tempRoot, 'dist');
    writeFileSync(joinInDist(distRoot, 'src/main/index.js'), 'main');
    writeFileSync(joinInDist(distRoot, 'src/preload/preload.js'), 'preload');
    writeFileSync(joinInDist(distRoot, 'src/shared/types.js'), 'shared');
    writeFileSync(joinInDist(distRoot, 'src/worker-agent/worker-config.js'), 'worker config');
    writeFileSync(joinInDist(distRoot, 'src/worker-agent/cli/pairing-config.js'), 'pairing config');
    writeFileSync(joinInDist(distRoot, 'worker-agent/index.js'), 'bundled worker');

    execFileSync(process.execPath, [join(tempScriptDir, 'sync-dist.js')], {
      cwd: tempRoot,
      stdio: 'pipe',
    });

    expect(readFileSync(join(distRoot, 'main/index.js'), 'utf8')).toBe('main');
    expect(readFileSync(join(distRoot, 'worker-agent/worker-config.js'), 'utf8')).toBe('worker config');
    expect(readFileSync(join(distRoot, 'worker-agent/cli/pairing-config.js'), 'utf8')).toBe('pairing config');
    expect(readFileSync(join(distRoot, 'worker-agent/index.js'), 'utf8')).toBe('bundled worker');
    expect(existsSync(join(distRoot, 'src/worker-agent/worker-config.js'))).toBe(true);
  });
});

function joinInDist(distRoot: string, relativePath: string): string {
  const target = join(distRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}
