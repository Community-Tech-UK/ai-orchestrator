import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
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
  version: string;
}

/**
 * A version read is reused while the install's file is unchanged, for at most
 * this long. Discovery and helper commands select an install every few
 * minutes; without this each one started a `--version` process per install.
 */
const VERSION_CACHE_MAX_AGE_MS = 10 * 60_000;

interface CachedVersion {
  identity: string;
  output: string;
  checkedAt: number;
}

/**
 * Keyed by folder and command: version managers (mise, asdf, volta) can run a
 * different OpenCode per folder behind the same unchanged shim file.
 */
const versionCache = new Map<string, CachedVersion>();
/** Last "skipped installs" summary logged per required major and folder, so an unchanged one is not repeated. */
const lastSkipSummaries = new Map<string, string | null>();

export function _resetOpenCodeLaunchCacheForTesting(): void {
  versionCache.clear();
  lastSkipSummaries.clear();
}

function lookupOnPath(name: string, spawnOptions: ReturnType<typeof buildCliSpawnOptions>): Promise<string[]> {
  const windows = process.platform === 'win32';
  // Asynchronous on purpose: this runs on the main process every few minutes,
  // and a synchronous lookup held the whole app until `which` returned.
  return new Promise((resolve) => {
    execFile(windows ? 'where' : 'which', windows ? [name] : ['-a', name], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, ...spawnOptions,
    }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(String(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && existsSync(line)));
    });
  });
}

async function pathCandidates(env: NodeJS.ProcessEnv): Promise<string[]> {
  // Factory env contains overrides, not a complete process environment. Use
  // the same inherited HOME/PATH as the probes and the eventual ACP spawn.
  const spawnOptions = buildCliSpawnOptions({ ...getSafeEnvForTrustedProcess(), ...env });
  const lists = await Promise.all(['opencode', 'opencode2'].map((name) => lookupOnPath(name, spawnOptions)));
  return lists.flat();
}

export async function listOpenCodeCommandCandidates(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of [...await pathCandidates(env), ...getCliCandidatePaths(CLI_REGISTRY.opencode, { ...getSafeEnvForTrustedProcess(), ...env }).filter((path) => existsSync(path))]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

/** Identifies the installed file, so an update or reinstall invalidates its cached version. */
async function installIdentity(command: string): Promise<string | undefined> {
  try {
    const target = await realpath(command);
    const info = await stat(target);
    return `${target}\0${info.ino}\0${info.size}\0${info.mtimeMs}`;
  } catch {
    return undefined;
  }
}

function versionCacheKey(command: string, workingDirectory: string): string {
  return `${workingDirectory}\0${command}`;
}

/** `--version` output, reused while the install is unchanged. Failed reads are never cached. */
async function readVersionOutput(
  command: string,
  workingDirectory: string,
  capture: (command: string, args: string[]) => Promise<{ code: number; stdout: string }>,
): Promise<string> {
  const key = versionCacheKey(command, workingDirectory);
  const identity = await installIdentity(command);
  const cached = versionCache.get(key);
  if (identity && cached?.identity === identity && Date.now() - cached.checkedAt < VERSION_CACHE_MAX_AGE_MS) {
    return cached.output;
  }
  const version = await capture(command, ['--version']).catch(() => undefined);
  const output = version?.code === 0 ? version.stdout : '';
  if (identity && /(\d+\.\d+\.\d+)/.test(output)) {
    versionCache.set(key, { identity, output, checkedAt: Date.now() });
  } else {
    versionCache.delete(key);
  }
  return output;
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
  const candidates = params.candidates ?? await listOpenCodeCommandCandidates(params.env);
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
    const versionOutput = await readVersionOutput(command, params.workingDirectory, capture);
    const matchedVersion = /(\d+\.\d+\.\d+)/.exec(versionOutput)?.[1];
    if (!matchedVersion) {
      unknownVersion += 1;
      continue;
    }
    const major = supportedOpenCodeMajor(versionOutput);
    if (major === undefined) { unsupported += 1; continue; }
    if (params.requiredMajor !== undefined && major !== params.requiredMajor) continue;
    supported.push({ command, major, version: matchedVersion });
  }
  supported.sort((left, right) => right.major - left.major);
  for (const { command, major, version } of supported) {
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
      // The remembered version may be what made this probe wrong; read it afresh next time.
      versionCache.delete(versionCacheKey(command, params.workingDirectory));
      unreadable += 1;
      continue;
    }
    const skipSummary = unknownVersion + unsupported + unreadable > 0
      ? `${command}|${major}|${unknownVersion}|${unsupported}|${unreadable}`
      : null;
    const summaryKey = `${params.requiredMajor ?? 'any'}\0${params.workingDirectory}`;
    if (skipSummary !== null && skipSummary !== lastSkipSummaries.get(summaryKey)) {
      logger.warn('Skipped unusable OpenCode installs; using another', { major, unknownVersion, unsupported, unreadable });
    }
    lastSkipSummaries.set(summaryKey, skipSummary);
    return { command, major, version };
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
