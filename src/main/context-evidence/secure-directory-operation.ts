import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { EvidenceStorageError } from './evidence-storage.types';

const OPERATION_TIMEOUT_MS = 10_000;
const EXIT_INVALID_REQUEST = 70;
const EXIT_IDENTITY_MISMATCH = 71;

export interface SecureDirectoryIdentity {
  path: string;
  device: number;
  inode: number;
}

export type SecureDirectoryOperation =
  | { kind: 'rename'; sourceName: string; targetName: string }
  | { kind: 'remove'; sourceName: string };

export type DirectoryOperationNotice = SecureDirectoryOperation & { directoryPath: string };

export type BeforeDirectoryOperation = (
  operation: DirectoryOperationNotice,
) => Promise<void>;

interface OperationChild extends NodeJS.EventEmitter {
  kill(): boolean;
}

type UtilityProcessFork = (
  modulePath: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    execArgv?: string[];
    serviceName: string;
    stdio: 'ignore';
  },
) => OperationChild;

export async function performSecureDirectoryOperation(
  identity: SecureDirectoryIdentity,
  operation: SecureDirectoryOperation,
  beforeOperation?: BeforeDirectoryOperation,
): Promise<void> {
  const notice = { ...operation, directoryPath: identity.path };
  await beforeOperation?.(notice);

  const entrypoint = join(
    __dirname,
    `secure-directory-operation-child${__filename.endsWith('.ts') ? '.ts' : '.js'}`,
  );
  const args = [
    operation.kind,
    String(identity.device),
    String(identity.inode),
    operation.sourceName,
    operation.kind === 'rename' ? operation.targetName : '',
  ];

  let child: OperationChild;
  try {
    child = createOperationChild(entrypoint, args, identity.path);
  } catch {
    throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
  }

  const exitCode = await waitForExit(child);
  if (exitCode === 0) return;
  if (exitCode === EXIT_INVALID_REQUEST || exitCode === EXIT_IDENTITY_MISMATCH) {
    throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
  }
  throw new Error('Evidence directory operation failed');
}

function createOperationChild(
  entrypoint: string,
  args: string[],
  cwd: string,
): OperationChild {
  const env = minimalChildEnvironment();
  const utilityFork = resolveUtilityProcessFork();
  if (utilityFork) {
    return utilityFork(entrypoint, args, {
      cwd,
      env,
      serviceName: 'AIO Evidence Directory Operation',
      stdio: 'ignore',
    });
  }

  const execArgv = entrypoint.endsWith('.ts')
    ? ['--import', createRequire(__filename).resolve('tsx')]
    : [];
  return spawn(process.execPath, [...execArgv, entrypoint, ...args], {
    cwd,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
}

function resolveUtilityProcessFork(): UtilityProcessFork | null {
  if (!process.versions.electron) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      utilityProcess?: { fork: UtilityProcessFork };
    };
    return electron.utilityProcess?.fork.bind(electron.utilityProcess) ?? null;
  } catch {
    return null;
  }
}

function minimalChildEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function waitForExit(child: OperationChild): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(code);
    };
    const timeout = setTimeout(() => {
      child.kill();
      settle(-1);
    }, OPERATION_TIMEOUT_MS);
    timeout.unref?.();
    child.once('error', () => settle(-1));
    child.once('exit', (code: number | null) => settle(code ?? -1));
  });
}
