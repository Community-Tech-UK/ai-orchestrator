import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { buildCliSpawnOptions } from '../cli-environment';
import { getLogger } from '../../logging/logger';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { CLI_REGISTRY, getCliCandidatePaths } from '../cli-registry';
import { withOpenCodeProcessGate } from './opencode-process-gate';
import { serializeOpenCodeConfigForV2 } from './opencode-v2-config';
import { openCodeProbeArgs, runOpenCodeCapture } from './opencode-effective-budget-config';
import { supportedOpenCodeMajor } from '../../../shared/utils/opencode-supported-version';
export { MIN_SUPPORTED_OPENCODE_2_VERSION } from '../../../shared/utils/opencode-supported-version';

const logger = getLogger('OpenCodeCliLaunch');

export interface OpenCodeLaunch {
  command: string;
  major: number;
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  // Factory env contains overrides, not a complete process environment. Use
  // the same inherited HOME/PATH as the probes and the eventual ACP spawn.
  const spawnOptions = buildCliSpawnOptions({ ...getSafeEnvForTrustedProcess(), ...env });
  return ['opencode', 'opencode2'].flatMap((name) => {
    const listed = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['-a', name].filter((arg) => process.platform !== 'win32' || arg !== '-a'), {
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, ...spawnOptions,
    });
    if (listed.status !== 0) return [];
    return listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && existsSync(line));
  });
}

export function listOpenCodeCommandCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of [...pathCandidates(env), ...getCliCandidatePaths(CLI_REGISTRY.opencode, { ...getSafeEnvForTrustedProcess(), ...env }).filter((path) => existsSync(path))]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

function jsonConfig(stdout: string, major: number): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (major === 2) return Array.isArray(parsed) && parsed.every((entry: unknown) => typeof entry === 'object' && entry !== null && 'type' in entry && (entry.type === 'directory' || (entry.type === 'document' && 'info' in entry && typeof entry.info === 'object' && entry.info !== null)));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function unusableOpenCodeMessage(unreadable: boolean, unsupported: boolean, requiredMajor?: 1 | 2): string {
  const cause = unreadable
    ? 'The OpenCode command-line tool could not read its settings in this folder.'
    : 'Harness could not find a working OpenCode command-line tool.';
  const install2 = 'OpenCode 2.0.30 or newer with `npm install -g @opencode/cli@2`';
  const install1 = 'OpenCode 1 with `npm install -g opencode-ai@1`';
  const required = requiredMajor ? `This session requires OpenCode ${requiredMajor}. ` : '';
  return `${required}${cause} Install ${requiredMajor === 2 ? install2 : requiredMajor === 1 ? install1 : `${install2}, or ${install1}`}.`
    + (unsupported && requiredMajor !== 1 ? ' An installed OpenCode version is unsupported; update OpenCode 2 to at least 2.0.30.' : '');
}

/** Version checks precede database access. Prefer supported 2.x, then 1.x. Caller holds startup gate. */
export async function selectOpenCodeLaunch(params: {
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  writableRoots?: readonly string[];
  candidates?: readonly string[];
  requiredMajor?: 1 | 2;
}): Promise<OpenCodeLaunch> {
  const candidates = params.candidates ?? listOpenCodeCommandCandidates(params.env);
  const capture = (command: string, args: string[], env = params.env) => runOpenCodeCapture({
    command,
    args,
    workingDirectory: params.workingDirectory,
    env,
    writableRoots: params.writableRoots,
  });
  let unknownVersion = 0;
  let unsupported = 0;
  let unreadable = 0;
  const supported: OpenCodeLaunch[] = [];
  for (const command of candidates) {
    const version = await capture(command, ['--version']).catch(() => undefined);
    if (!version || version.code !== 0 || !/\d+\.\d+\.\d+/.test(version.stdout)) {
      unknownVersion += 1;
      continue;
    }
    const major = supportedOpenCodeMajor(version.stdout);
    if (major === undefined) { unsupported += 1; continue; }
    if (params.requiredMajor !== undefined && major !== params.requiredMajor) continue;
    supported.push({ command, major });
  }
  supported.sort((left, right) => right.major - left.major);
  for (const { command, major } of supported) {
    let probeEnv = params.env;
    if (major === 2 && probeEnv['OPENCODE_CONFIG_CONTENT']) {
      try {
        const config: unknown = JSON.parse(probeEnv['OPENCODE_CONFIG_CONTENT']);
        if (typeof config !== 'object' || config === null || Array.isArray(config)) { unreadable += 1; continue; }
        serializeOpenCodeConfigForV2(config as Record<string, unknown>);
        probeEnv = { ...probeEnv, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
      } catch { unreadable += 1; continue; }
    }
    const printsConfig = await capture(command, openCodeProbeArgs(major), probeEnv)
      .then((config) => config.code === 0 && jsonConfig(config.stdout, major), () => false);
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
  throw new Error(unusableOpenCodeMessage(unreadable > 0, unsupported > 0, params.requiredMajor));
}

/** Shared resolver for helper commands outside an adapter startup. */
export async function resolveOpenCodeLaunch(params: {
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<OpenCodeLaunch> {
  return withOpenCodeProcessGate(() => selectOpenCodeLaunch({
    workingDirectory: params.workingDirectory ?? process.cwd(),
    env: params.env ?? process.env,
  }));
}
