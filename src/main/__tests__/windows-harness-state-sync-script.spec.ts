import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const scriptSource = readFileSync(
  resolve(specDirectory, '../../../scripts/windows/harness-state-sync.ps1'),
  'utf8',
);

describe('Windows Harness state sync script', () => {
  it('mirrors all durable session and memory state roots', () => {
    const expectedDurableDirs = [
      'rlm',
      'conversation-history',
      'conversation-ledger',
      'session-continuity',
      'projects',
      'transaction-logs',
      'archived-sessions',
      'content-store',
      'output-storage',
      'child-results',
      'snapshots',
      'operator',
      'loop-mode',
    ];

    for (const dir of expectedDurableDirs) {
      expect(scriptSource).toMatch(new RegExp(`'${dir}'[,\\r\\n]`));
    }
  });

  it('refuses OneDrive-backed state roots and sync hubs', () => {
    expect(scriptSource).toContain('function Assert-NotOneDrivePath');
    expect(scriptSource).toMatch(/Assert-NotOneDrivePath\s+-PathValue\s+\$resolvedUserData\s+-Label\s+'UserDataRoot'/);
    expect(scriptSource).toMatch(/Assert-NotOneDrivePath\s+-PathValue\s+\$resolvedHub\s+-Label\s+'HubPath'/);
  });

  it('keeps shadow working-tree checkpoints out of the shared sync hub', () => {
    expect(scriptSource).toContain("$projectMirrorExcludeDirs = @('shadow-repo')");
    expect(scriptSource).toContain("if ($dir -eq 'projects')");
    expect(scriptSource).toMatch(/Invoke-RobocopyMirror\s+-Source\s+\$source\s+-Destination\s+\$dest\s+-ExcludeDirs\s+\$excludeDirs/);
  });

  it('prunes stale shadow working-tree checkpoints from the hub on push', () => {
    expect(scriptSource).toContain('function Remove-ProjectShadowRepos');
    expect(scriptSource).toContain("if ($Direction -eq 'push' -and $dir -eq 'projects')");
    expect(scriptSource).toMatch(/Remove-ProjectShadowRepos\s+-ProjectsRoot\s+\$dest/);
  });
});
