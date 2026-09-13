import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import type { NodeExecParams } from '../main/remote-node/node-control-rpc-schemas';
import { assertNodeExecArgvPolicy } from '../main/app/run-on-node-exec-policy';
import { normalizedCommandBasename } from '../main/app/run-on-node-posix-policy';
import type { WorkerConfig } from './worker-config';
import { isPathAllowed } from './path-sandbox';
import {
  resolveTrustedNodeExecExecutable,
  type TrustedNodeExecExecutableResolver,
} from './worker-node-command-resolver';

export const NODE_EXEC_MAX_SCRIPT_BYTES = 256 * 1024;

const POWERSHELL_EXECUTABLES = new Set([
  'powershell', 'powershell.exe',
]);
const POWERSHELL_VALUE_OPTIONS = new Set([
  'configurationname', 'custompipename', 'encodedarguments', 'encodedcommand',
  'executionpolicy', 'inputformat', 'outputformat', 'settingsfile',
  'windowstyle', 'workingdirectory',
]);
const POWERSHELL_SWITCH_OPTIONS = new Set([
  'login', 'mta', 'noexit', 'nologo', 'noninteractive', 'noprofile', 'sta',
]);

export type NodeExecAllowedRoots = readonly string[] | (() => readonly string[]);

export interface PreparedNodeExec {
  readonly executable: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly input?: string;
}

export class WorkerNodeExecPolicyError extends Error {
  override name = 'WorkerNodeExecPolicyError';
}

function usesPathDependentPowerShellMetadata(script: string): boolean {
  const automaticName = '(?:psscriptroot|pscommandpath|myinvocation)';
  const scope = '(?:[a-z_][\\w-]*:)?';
  const normalized = script
    .replace(/`\$/gu, '\u0000')
    .replace(/`(.)/gsu, '$1');
  return new RegExp(
    `\\$(?:\\{${scope}${automaticName}\\}|${scope}${automaticName}\\b)`,
    'iu',
  ).test(normalized);
}

/**
 * Execution roots include ordinary worker workspaces and writable transfer
 * roots. Read-only transfer roots (notably Downloads) are intentionally not
 * executable through node.exec.
 */
export function configuredNodeExecRoots(
  config: Pick<WorkerConfig, 'workingDirectories' | 'fileTransfer'>,
): readonly string[] {
  const writableTransferRoots = config.fileTransfer?.enabled === false
    ? []
    : (config.fileTransfer?.roots ?? [])
      .filter((root) => root.write)
      .map((root) => root.path);
  return [...config.workingDirectories, ...writableTransferRoots];
}

/**
 * Worker-side defense in depth. The coordinator applies the same launcher
 * policy, but service RPC is an independent trust boundary and must not rely
 * on that caller having run it.
 */
export function assertWorkerNodeExecArgvPolicy(
  executable: string,
  args: readonly string[],
): void {
  try {
    assertNodeExecArgvPolicy(executable, args);
  } catch (error) {
    throw policyError(error);
  }
}

/**
 * Bind PowerShell -File execution to the digest returned by upload_to_node.
 * The exact approved bytes are decoded, admitted only by the shared literal-only
 * PowerShell grammar, and supplied through stdin with `-File -`, so no mutable
 * pathname is reopened after verification. Path-dependent semantics are rejected.
 */
export async function prepareWorkerNodeExec(
  params: NodeExecParams,
  cwd: string | undefined,
  allowedRoots: NodeExecAllowedRoots,
  resolveExecutable: TrustedNodeExecExecutableResolver = resolveTrustedNodeExecExecutable,
): Promise<PreparedNodeExec> {
  assertWorkerNodeExecArgvPolicy(params.executable, params.args);
  let executable: string;
  try {
    executable = await resolveExecutable(params.executable);
  } catch (error) {
    throw new WorkerNodeExecPolicyError(
      error instanceof Error ? error.message : 'trusted node.exec executable resolution failed',
    );
  }
  const fileInvocation = powerShellFileInvocation(params.executable, params.args);
  if (!fileInvocation) {
    return {
      executable,
      args: canonicalNodeExecArgs(params.executable, params.args),
      env: sanitizedNodeExecEnvironment(),
    };
  }

  const expectedHash = params.scriptSha256;
  if (!expectedHash) {
    throw new WorkerNodeExecPolicyError(
      'PowerShell -File requires scriptSha256 from the verified file-transfer result',
    );
  }
  const requestedPath = params.args[fileInvocation.fileArgIndex]?.trim() ?? '';
  if (!requestedPath || requestedPath === '-' || extname(requestedPath).toLowerCase() !== '.ps1') {
    throw new WorkerNodeExecPolicyError('PowerShell -File requires a readable .ps1 script path');
  }

  const roots = await resolveExistingRoots(resolveRootSource(allowedRoots));
  const processCwd = cwd ?? process.cwd();
  const scriptBaseDirectory = fileInvocation.workingDirectory
    ? resolve(processCwd, fileInvocation.workingDirectory)
    : processCwd;
  const absoluteRequestedPath = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(scriptBaseDirectory, requestedPath);
  let resolvedScriptPath: string;
  try {
    resolvedScriptPath = await realpath(absoluteRequestedPath);
  } catch {
    throw new WorkerNodeExecPolicyError('PowerShell script does not exist or cannot be resolved');
  }
  if (!isPathAllowed(resolvedScriptPath, roots)) {
    throw new WorkerNodeExecPolicyError(
      'PowerShell script is outside configured worker execution roots',
    );
  }

  const content = await readBoundedRegularFile(resolvedScriptPath);
  if (sha256(content) !== expectedHash) {
    throw new WorkerNodeExecPolicyError(
      'PowerShell script SHA-256 changed or does not match scriptSha256',
    );
  }
  const scriptText = decodePowerShellScript(content);
  if (usesPathDependentPowerShellMetadata(scriptText)) {
    throw new WorkerNodeExecPolicyError(
      'PowerShell script uses path-dependent invocation metadata that is unavailable to stdin execution',
    );
  }
  try {
    assertNodeExecArgvPolicy(params.executable, ['-Command', scriptText]);
  } catch (error) {
    throw policyError(error);
  }

  const scriptArgs = params.args.slice(fileInvocation.fileArgIndex + 1);
  return {
    executable,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', '-', ...scriptArgs],
    env: sanitizedNodeExecEnvironment(),
    input: scriptText,
  };
}

function canonicalNodeExecArgs(executable: string, args: readonly string[]): string[] {
  const basename = normalizedCommandBasename(executable);
  if (POWERSHELL_EXECUTABLES.has(basename)) {
    return [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      powerShellInlineSource(args),
    ];
  }
  if (basename === 'curl' || basename === 'curl.exe') return ['--disable', ...args];
  return [...args];
}

function powerShellInlineSource(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const option = powerShellOptionName(args[index] ?? '');
    if (option && (option === 'c' || 'command'.startsWith(option))) {
      return args.slice(index + 1).join(' ');
    }
    if (option && [...POWERSHELL_VALUE_OPTIONS].some((name) => name.startsWith(option))) {
      index += 1;
      continue;
    }
    if (option && [...POWERSHELL_SWITCH_OPTIONS].some((name) => name.startsWith(option))) continue;
    if (!option) return args.slice(index).join(' ');
  }
  throw new WorkerNodeExecPolicyError('PowerShell command mode requires a literal output command');
}

function sanitizedNodeExecEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const systemRoot = source['SystemRoot'] ?? source['SYSTEMROOT'] ?? 'C:\\Windows';
  const env: NodeJS.ProcessEnv = {
    HOME: platform === 'win32' ? `${systemRoot}\\Temp\\aio-node-exec-empty-profile` : '/var/empty',
    PATH: platform === 'win32'
      ? `${systemRoot}\\System32;${systemRoot};${systemRoot}\\System32\\WindowsPowerShell\\v1.0`
      : '/usr/bin:/bin',
    ...(platform === 'win32'
      ? { USERPROFILE: `${systemRoot}\\Temp\\aio-node-exec-empty-profile` }
      : {}),
  };
  for (const name of ['LANG', 'LC_ALL', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR']) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

interface PowerShellFileInvocation {
  fileArgIndex: number;
  workingDirectory?: string;
}

function powerShellFileInvocation(
  executable: string,
  args: readonly string[],
): PowerShellFileInvocation | undefined {
  if (!POWERSHELL_EXECUTABLES.has(normalizedCommandBasename(executable))) return undefined;
  let workingDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = powerShellOptionName(args[index] ?? '');
    if (!option) return undefined;
    if (option === 'c' || 'command'.startsWith(option) || option === 'cwa'
      || 'commandwithargs'.startsWith(option)) return undefined;
    if (option === 'ec' || 'encodedcommand'.startsWith(option)) return undefined;
    if (option === 'f' || 'file'.startsWith(option)) {
      return {
        fileArgIndex: index + 1,
        ...(workingDirectory ? { workingDirectory } : {}),
      };
    }
    if ([...POWERSHELL_VALUE_OPTIONS].some((name) => name.startsWith(option))) {
      if (args[index + 1] === undefined) return undefined;
      if ('workingdirectory'.startsWith(option)) workingDirectory = args[index + 1];
      index += 1;
      continue;
    }
    if ([...POWERSHELL_SWITCH_OPTIONS].some((name) => name.startsWith(option))) continue;
    if (args.slice(index + 1).some((arg) => {
      const later = powerShellOptionName(arg);
      return later === 'f' || (later !== undefined && 'file'.startsWith(later));
    })) {
      throw new WorkerNodeExecPolicyError(
        'PowerShell -File must follow only recognized non-command startup options',
      );
    }
    return undefined;
  }
  return undefined;
}

function powerShellOptionName(value: string): string | undefined {
  return /^[-/\u2010-\u2015\u2212]([a-z]+)$/iu.exec(value)?.[1]?.toLowerCase();
}

function resolveRootSource(source: NodeExecAllowedRoots): readonly string[] {
  return typeof source === 'function' ? source() : source;
}

async function resolveExistingRoots(roots: readonly string[]): Promise<string[]> {
  const resolvedRoots = await Promise.all(roots.map(async (root) => {
    try {
      return await realpath(root);
    } catch {
      return null;
    }
  }));
  return [...new Set(resolvedRoots.filter((root): root is string => root !== null))];
}

async function readBoundedRegularFile(filePath: string): Promise<Buffer> {
  try {
    if (!(await lstat(filePath)).isFile()) {
      throw new WorkerNodeExecPolicyError('PowerShell script must be a regular file');
    }
  } catch (error) {
    if (error instanceof WorkerNodeExecPolicyError) throw error;
    throw new WorkerNodeExecPolicyError('PowerShell script is unreadable or non-regular');
  }
  let handle: FileHandle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new WorkerNodeExecPolicyError('PowerShell script is unreadable');
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new WorkerNodeExecPolicyError('PowerShell script must be a regular file');
    }
    if (before.size > NODE_EXEC_MAX_SCRIPT_BYTES) {
      throw new WorkerNodeExecPolicyError(
        `PowerShell script exceeds ${NODE_EXEC_MAX_SCRIPT_BYTES} bytes`,
      );
    }
    const content = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < content.length) {
      const read = await handle.read(content, offset, content.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new WorkerNodeExecPolicyError('PowerShell script changed while it was being read');
    }
    let canonicalAfter: string;
    let pathAfter;
    try {
      [canonicalAfter, pathAfter] = await Promise.all([realpath(filePath), stat(filePath)]);
    } catch {
      throw new WorkerNodeExecPolicyError('PowerShell script changed while it was being read');
    }
    const identityChanged = canonicalAfter !== filePath
      || pathAfter.dev !== after.dev
      || (pathAfter.ino !== 0 && after.ino !== 0 && pathAfter.ino !== after.ino);
    if (identityChanged) {
      throw new WorkerNodeExecPolicyError('PowerShell script identity changed while it was being read');
    }
    return content.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function decodePowerShellScript(content: Buffer): string {
  try {
    if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: true }).decode(content.subarray(2));
    }
    if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
      return new TextDecoder('utf-16be', { fatal: true }).decode(content.subarray(2));
    }
    const withoutBom = content.length >= 3
      && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
      ? content.subarray(3)
      : content;
    return new TextDecoder('utf-8', { fatal: true }).decode(withoutBom);
  } catch {
    throw new WorkerNodeExecPolicyError('PowerShell script is not valid UTF-8 or BOM-marked UTF-16');
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function policyError(error: unknown): WorkerNodeExecPolicyError {
  return new WorkerNodeExecPolicyError(
    error instanceof Error ? error.message : 'node.exec browser-launch policy rejected argv',
  );
}
