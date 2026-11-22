import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledRtkBinary, expectedRtkLabel } from '../audit/rtk-native-hook-probe.mjs';

const root = resolve(__dirname, '../..');
const binary = bundledRtkBinary(root);

describe('the deferred native RTK probe preflight', () => {
  it('expects the version the repository manifest pins, with none written into the script', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'scripts/rtk-binaries.sha256.json'), 'utf8')) as { version: string };
    expect(expectedRtkLabel(root)).toBe(`rtk ${manifest.version}`);
    const source = readFileSync(join(root, 'scripts/audit/rtk-native-hook-probe.mjs'), 'utf8');
    expect(source).toContain('scripts/rtk-binaries.sha256.json');
    expect(source).not.toMatch(/rtk \d+\.\d+\.\d+/);
  });

  it('turns on the hook\'s rewrite-only mode through the environment variable the hook actually reads', () => {
    const probe = readFileSync(join(root, 'scripts/audit/rtk-native-hook-probe.mjs'), 'utf8');
    const hook = readFileSync(join(root, 'src/main/cli/hooks/rtk-defer-hook.mjs'), 'utf8');
    // The hook has no command-line flags: a `--rewrite-only` argument is ignored and leaves the ordinary defer hook running.
    expect(hook).toContain("process.env.ORCHESTRATOR_RTK_REWRITE_ONLY === '1'");
    expect(hook).toContain('process.env.ORCHESTRATOR_RTK_LOG_DIR');
    expect(probe).toContain("ORCHESTRATOR_RTK_REWRITE_ONLY: '1'");
    expect(probe).toContain('ORCHESTRATOR_RTK_LOG_DIR');
    expect(probe).not.toContain('--rewrite-only');
  });

  describe.runIf(process.platform !== 'win32' && existsSync(binary))('with the bundled binary (no provider call)', () => {
    it('accepts the repository binary before any provider call', () => {
      const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe(expectedRtkLabel(root));
    });
  });
});
