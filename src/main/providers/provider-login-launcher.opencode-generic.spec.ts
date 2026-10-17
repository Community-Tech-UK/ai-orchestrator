import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';
import * as portableLogin from '../../shared/utils/opencode-account-login-command';
import { LEGACY_ACCOUNT_PROFILE_ID } from '../../shared/types/provider-account.types';

// Intercept imports inside a VM rather than mocking a native module globally:
// no failure to apply a mock can ever open a real terminal or execute a CLI.
const compiled = transpileModule(readFileSync(join(process.cwd(), 'src/main/providers/provider-login-launcher.ts'), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;

async function genericLogin(command: string, major: number, platform: NodeJS.Platform = 'darwin'): Promise<string> {
  const exported: Record<string, unknown> = {};
  runInNewContext(compiled, {
    exports: exported,
    process: { platform },
    btoa,
    require: (id: string): unknown => {
      if (id === 'node:child_process') return {
        execFile: (_file: string, _args: string[], callback: (error: null, stdout: string, stderr: string) => void) => callback(null, '', ''),
        spawn: () => {
          const child = Object.assign(new EventEmitter(), { unref: () => undefined });
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
      };
      if (id === '../logging/logger') return { getLogger: () => ({ info: () => undefined, warn: () => undefined }) };
      if (id === '../cli/adapters/opencode-cli-launch') return { resolveOpenCodeLaunch: async () => ({ command, major }) };
      if (id === '../../shared/utils/opencode-account-login-command') return portableLogin;
      if (id === '../../shared/types/provider-account.types') return { LEGACY_ACCOUNT_PROFILE_ID };
      // Other imported account helpers are unused by this generic route.
      return {};
    },
  });
  const launch = exported['launchProviderLogin'];
  if (typeof launch !== 'function') throw new Error('Actual provider launcher export is unavailable.');
  const result: unknown = await launch('opencode');
  if (!result || typeof result !== 'object' || !('command' in result) || typeof result.command !== 'string') {
    throw new Error('Actual provider launcher did not return a command.');
  }
  return result.command;
}

function execute(command: string, version: string, platform: NodeJS.Platform = 'darwin') {
  const encoded = command.match(/Buffer.from\('([^']+)'/)?.[1];
  if (!encoded) throw new Error('The portable terminal command was not encoded.');
  const probes: { command: string; args: string[] }[] = [];
  const auth: { command: string; args: string[]; shell: boolean }[] = [];
  const run = () => runInNewContext(Buffer.from(encoded, 'base64').toString('utf8'), {
    process: { platform },
    require: (id: string): unknown => {
      if (id === 'node:child_process') return {
        spawnSync: (selected: string, args: string[]) => {
          probes.push({ command: selected, args });
          return { status: 0, stdout: version };
        },
        spawn: (selected: string, args: string[], options: { shell: boolean }) => {
          auth.push({ command: selected, args, shell: options.shell });
          return new EventEmitter();
        },
      };
      if (['node:fs', 'node:os', 'node:path'].includes(id)) return {};
      throw new Error(`Unexpected terminal script import: ${id}`);
    },
  });
  return { probes, auth, run };
}

describe('generic OpenCode Doctor sign-in at the terminal boundary', () => {
  it.each([
    ['darwin', '/fixture/opencode2'],
    ['darwin', '/fixture/José/opencode2'],
    ['darwin', '/fixture/测试/opencode2'],
    ['darwin', '/fixture/🧪/opencode2'],
    ['win32', 'C:\\Users\\测试\\OpenCode App\\opencode.exe'],
  ] as const)('preserves the selected %s executable exactly: %s', async (platform, selected) => {
    const execution = execute(await genericLogin(selected, 2, platform), '2.0.30', platform);
    execution.run();
    expect(execution.probes).toEqual([{ command: selected, args: ['--version'] }]);
    expect(execution.auth).toEqual([{ command: selected, args: ['auth', 'login', '--standalone'], shell: false }]);
  });

  it.each(['2.0.18', '3.0.0', '2.0.30-beta.1', 'unavailable'])('refuses a replaced selected binary reporting %s before auth', async (version) => {
    const selected = '/fixture/opencode2';
    const execution = execute(await genericLogin(selected, 2), version);
    expect(execution.run).toThrow('No supported OpenCode command found');
    expect(execution.probes).toEqual([{ command: selected, args: ['--version'] }]);
    expect(execution.auth).toEqual([]);
  });

  it('retains version 1 native picker arguments and refuses a changed major', async () => {
    const selected = '/fixture/opencode';
    const command = await genericLogin(selected, 1);
    const supported = execute(command, '1.19.1');
    supported.run();
    expect(supported.auth).toEqual([{ command: selected, args: ['auth', 'login'], shell: false }]);
    const replaced = execute(command, '2.0.30');
    expect(replaced.run).toThrow('No supported OpenCode command found');
    expect(replaced.auth).toEqual([]);
  });
});
