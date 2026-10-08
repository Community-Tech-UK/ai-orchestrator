import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildCliSpawnOptions } from '../cli-environment';
import { getLogger } from '../../logging/logger';
import { runOpenCodeCapture } from './opencode-effective-budget-config';

const logger = getLogger('OpenCodeCliLaunch');
const SAFE_PROBE_ERROR = 'Unable to resolve OpenCode model limits safely; refusing to replace native configuration.';

export interface OpenCodeLaunch {
  command: string;
  major: number;
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  const spawnOptions = buildCliSpawnOptions(env);
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

/**
 * Use the first OpenCode install that can print its resolved config in this
 * directory. A newer desktop install can migrate the shared database so the
 * older CLI on PATH exits before ACP starts.
 */
export async function selectOpenCodeLaunch(params: {
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  writableRoots?: readonly string[];
  candidates?: readonly string[];
}): Promise<OpenCodeLaunch> {
  const candidates = params.candidates ?? listOpenCodeCommandCandidates(params.env);
  let skipped = 0;
  for (const command of candidates) {
    try {
      const config = await runOpenCodeCapture({
        command,
        args: ['debug', 'config'],
        workingDirectory: params.workingDirectory,
        env: params.env,
        writableRoots: params.writableRoots,
      });
      if (config.code !== 0 || !jsonConfig(config.stdout)) {
        skipped += 1;
        continue;
      }
      const version = await runOpenCodeCapture({
        command,
        args: ['--version'],
        workingDirectory: params.workingDirectory,
        env: params.env,
        writableRoots: params.writableRoots,
      });
      const major = version.code === 0 ? majorFromVersion(version.stdout) : undefined;
      if (!major) {
        skipped += 1;
        continue;
      }
      if (skipped > 0) {
        logger.warn('OpenCode CLI could not read its database; using another install', { major });
      }
      return { command, major };
    } catch {
      skipped += 1;
    }
  }
  throw new Error(SAFE_PROBE_ERROR);
}
