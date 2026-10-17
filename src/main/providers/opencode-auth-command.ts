import { execFile } from 'child_process';
import { resolveWindowsSpawn } from '../cli/adapters/windows-cli-spawn';
import { openCodeLoginSpawnTarget } from '../../shared/utils/opencode-account-login-command';
import { buildCliSpawnOptions } from '../cli/cli-environment';
import { selectOpenCodeLaunch } from '../cli/adapters/opencode-cli-launch';
import { withOpenCodeProcessGate } from '../cli/adapters/opencode-process-gate';
import { openCodeAuthListArgs, parseOpenCodeAuthList } from './opencode-auth-status';
import { readOpenCodeV2CredentialNames } from './opencode-credential-names';

/** Selected-install auth read. Failed/partial process output is never sign-in evidence. */
export function readSelectedOpenCodeAuthList(): Promise<string | null> {
  return withOpenCodeProcessGate(async () => {
    const selected = await selectOpenCodeLaunch({ workingDirectory: process.cwd(), env: process.env });
    const spawnOptions = buildCliSpawnOptions();
    const target = resolveWindowsSpawn(selected.command, openCodeAuthListArgs(selected.major), Boolean(spawnOptions.shell), spawnOptions.env ?? {});
    const fallback = openCodeLoginSpawnTarget(target.command, target.shell ? process.platform : 'posix');
    const output = await new Promise<string | null>((resolve) => {
      execFile(fallback.command, target.args,
        { timeout: 8_000, maxBuffer: 256 * 1024, ...spawnOptions, shell: target.shell },
        (error, stdout) => resolve(error ? null : typeof stdout === 'string' ? stdout : String(stdout ?? '')));
    });
    if (selected.major < 2 || output === null || parseOpenCodeAuthList(output) === null) return output;
    const rows = JSON.parse(output) as { id: string; connections: unknown[] }[];
    for (const name of readOpenCodeV2CredentialNames()) {
      if (!rows.some((row) => row.id === name)) rows.push({ id: name, connections: [{ type: 'credential' }] });
    }
    return JSON.stringify(rows);
  });
}
