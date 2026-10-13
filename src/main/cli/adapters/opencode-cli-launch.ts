import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildCliSpawnOptions } from '../cli-environment';
import { getLogger } from '../../logging/logger';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { runOpenCodeCapture } from './opencode-effective-budget-config';

const logger = getLogger('OpenCodeCliLaunch');

/**
 * Newest OpenCode major version Harness starts sessions with (LT-705).
 * OpenCode 2's `acp` command (checked on 2.0.18) takes no options and attaches
 * to the shared background service, whose configuration was fixed when that
 * service started. The per-session OPENCODE_CONFIG_CONTENT carrying the
 * permission policy, generation budget and per-account MiMo providers never
 * reaches an OpenCode 2 session, so the startup checks would verify settings
 * the session does not use. Raise this only with a launch path whose session
 * honours that overlay; the version-2 branches in the adapter factory are not
 * enough alone.
 */
export const MAX_SUPPORTED_OPENCODE_MAJOR = 1;

export interface OpenCodeLaunch {
  command: string;
  major: number;
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  // Factory env contains overrides, not a complete process environment. Use
  // the same inherited HOME/PATH as the probes and the eventual ACP spawn.
  const spawnOptions = buildCliSpawnOptions({ ...getSafeEnvForTrustedProcess(), ...env });
  const listed = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['-a', 'opencode'], {
    encoding: 'utf8',
    ...spawnOptions,
  });
  if (listed.status !== 0) return [];
  return listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && existsSync(line));
}

function extraCandidates(): string[] {
  const home = homedir();
  return [
    process.platform === 'darwin' ? '/Applications/OpenCode.app/Contents/Resources/opencode-cli' : '',
    join(home, '.opencode', 'bin', 'opencode'),
    join(home, '.local', 'bin', 'opencode'),
  ].filter((candidate) => candidate.length > 0 && existsSync(candidate));
}

export function listOpenCodeCommandCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of [...pathCandidates(env), ...extraCandidates()]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

function majorFromVersion(text: string): number | undefined {
  const match = /(\d+)\.\d+\.\d+/.exec(text);
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isInteger(major) && major > 0 ? major : undefined;
}

function jsonConfig(stdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function unusableOpenCodeMessage(openCode1Failed: boolean, newerInstalled: boolean): string {
  // Shown after "This session could not start. Reason:", so no repeated preamble.
  const cause = openCode1Failed
    ? 'The OpenCode 1 command-line tool could not read its settings in this folder. To see why, check that `opencode --version` shows 1.x, then run `opencode debug config` here.'
    : 'Harness needs the OpenCode 1 command-line tool and could not find a working one. Install it with `npm install -g opencode-ai@1`.';
  return newerInstalled
    ? `${cause} A newer OpenCode is installed, but Harness can't use it yet: its sessions ignore Harness's settings for permissions, reply length and which MiMo account to use.`
    : cause;
}

/**
 * Use the first supported OpenCode install that can print its resolved config
 * in this directory. A newer desktop install can migrate the shared database so
 * an older CLI exits before ACP starts; Harness then refuses to start rather
 * than run the session on an unsupported version.
 */
export async function selectOpenCodeLaunch(params: {
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  writableRoots?: readonly string[];
  candidates?: readonly string[];
}): Promise<OpenCodeLaunch> {
  const candidates = params.candidates ?? listOpenCodeCommandCandidates(params.env);
  const capture = (command: string, args: string[]) => runOpenCodeCapture({
    command,
    args,
    workingDirectory: params.workingDirectory,
    env: params.env,
    writableRoots: params.writableRoots,
  });
  let unknownVersion = 0;
  let unsupported = 0;
  let unreadable = 0;
  for (const command of candidates) {
    // `--version` does not open the shared database, so an unsupported
    // install is skipped without touching it.
    const major = await capture(command, ['--version'])
      .then((version) => (version.code === 0 ? majorFromVersion(version.stdout) : undefined), () => undefined);
    if (!major) {
      unknownVersion += 1;
      continue;
    }
    if (major > MAX_SUPPORTED_OPENCODE_MAJOR) {
      unsupported += 1;
      continue;
    }
    const printsConfig = await capture(command, ['debug', 'config'])
      .then((config) => config.code === 0 && jsonConfig(config.stdout), () => false);
    if (!printsConfig) {
      unreadable += 1;
      continue;
    }
    if (unknownVersion + unsupported + unreadable > 0) {
      logger.warn('Skipped unusable OpenCode installs; using another', { major, unknownVersion, unsupported, unreadable });
    }
    return { command, major };
  }
  logger.warn('No usable OpenCode install', { candidates: candidates.length, unknownVersion, unsupported, unreadable });
  throw new Error(unusableOpenCodeMessage(unreadable > 0, unsupported > 0));
}
