import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const scriptsRoot = resolve(specDirectory, '../../../scripts/windows');

function readScript(name: string): string {
  return readFileSync(resolve(scriptsRoot, name), 'utf8');
}

describe('Windows Noah runbook scripts', () => {
  it('refuses OneDrive variants for repo, config, userData, and hub paths', () => {
    const workerFixSource = readScript('noah-worker-fix.ps1');
    const configCleanupSource = readScript('noah-config-path-cleanup.ps1');
    const stateSyncSource = readScript('harness-state-sync.ps1');

    for (const source of [workerFixSource, configCleanupSource, stateSyncSource]) {
      expect(source).toContain('function Assert-NotOneDrivePath');
      expect(source).toContain("OneDrive(?:\\s+-\\s+[^\\\\]+)?");
    }

    expect(workerFixSource).toContain("Assert-NotOneDrivePath -PathValue $repo -Label 'RepoPath'");
    expect(configCleanupSource).toContain("Assert-NotOneDrivePath -PathValue $NewPath -Label 'NewPath'");
    expect(stateSyncSource).toContain("Assert-NotOneDrivePath -PathValue $resolvedUserData -Label 'UserDataRoot'");
    expect(stateSyncSource).toContain("Assert-NotOneDrivePath -PathValue $resolvedHub -Label 'HubPath'");
  });

  it('keeps the Startup VBS worker launcher under supervisor control', () => {
    const workerFixSource = readScript('noah-worker-fix.ps1');

    expect(workerFixSource).toContain('--supervise');
    expect(workerFixSource).toMatch(/sh\.Run\s+"""\$resolvedNodeExe"" ""\$idx"" --supervise"/);
  });

  it('cleans raw and JSON-escaped Windows path references without printing matched values', () => {
    const configCleanupSource = readScript('noah-config-path-cleanup.ps1');

    expect(configCleanupSource).toContain('function ConvertTo-EscapedWindowsPath');
    expect(configCleanupSource).toContain('function Get-PathMatchVariants');
    expect(configCleanupSource).toContain('function Replace-PathVariants');
    expect(configCleanupSource).toContain('$Text.Replace($OldValue, $NewValue)');
    expect(configCleanupSource).toContain('$updated.Replace($oldEscaped, $newEscaped)');
    expect(configCleanupSource).toContain('function Get-CodexProjectHeaders');
    expect(configCleanupSource).toContain('[projects.`"$escapedPath`"]');
    expect(configCleanupSource).toContain('old path appears in $Path at line(s):');
    expect(configCleanupSource).not.toMatch(/Write-Host[^\n]*\$_\.Line(?!Number)/);
  });

  it('redacts token-bearing worker launcher discovery output', () => {
    const discoverSource = readScript('noah-worker-discover.ps1');

    expect(discoverSource).toContain('function Redact-SecretText');
    expect(discoverSource).toContain('--(?:token|auth-token|enrollment-token)');
    expect(discoverSource).toContain('(?:token|authToken|auth_token|access_token|refresh_token|client_secret)');
    expect(discoverSource).toMatch(/Select-Object ProcessId, @\{Name = 'CommandLine'; Expression = \{ Redact-SecretText \$_.CommandLine \}\}/);
    expect(discoverSource).toMatch(/Get-Content -LiteralPath \$launcher\.FullName \| ForEach-Object \{ Redact-SecretText \$_ \}/);
    expect(discoverSource).toMatch(/Get-Content -LiteralPath \$src \| ForEach-Object \{ Redact-SecretText \$_ \}/);
  });
});
