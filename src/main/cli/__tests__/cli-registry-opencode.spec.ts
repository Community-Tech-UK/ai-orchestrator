import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_REGISTRY, getCliCandidatePaths } from '../cli-registry';

describe('OpenCode install candidates', () => {
  it('finds desktop version directories newest first and opencode2 alternatives', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-candidates-'));
    try {
      const root = join(home, 'Library/Application Support/ai.opencode.desktop/cli');
      for (const version of ['2.0.9', '2.0.30']) {
        mkdirSync(join(root, version), { recursive: true });
        writeFileSync(join(root, version, 'opencode-cli'), 'fixture executable');
      }
      const paths = getCliCandidatePaths(CLI_REGISTRY.opencode, { HOME: home }, 'darwin');
      expect(paths.indexOf(join(root, '2.0.30/opencode-cli'))).toBeLessThan(paths.indexOf(join(root, '2.0.9/opencode-cli')));
      expect(paths).toContain(join(root, '2.0.30/opencode-cli'));
      expect(paths).toContain(join(home, '.local/bin/opencode2'));
      expect(paths).toContain('/Applications/OpenCode.app/Contents/Resources/opencode-cli');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('includes Windows native and WinGet aliases for both command names', () => {
    const paths = getCliCandidatePaths(CLI_REGISTRY.opencode, { USERPROFILE: 'C:\\Users\\fixture', LOCALAPPDATA: 'C:\\Local' }, 'win32');
    expect(paths).toContain('C:\\Local\\Microsoft\\WinGet\\Links\\opencode.exe');
    expect(paths.some((path) => path.endsWith('opencode2.exe'))).toBe(true);
  });
});
