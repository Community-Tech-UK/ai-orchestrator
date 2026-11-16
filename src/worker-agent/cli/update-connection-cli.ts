import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { acquireSingleInstanceLock, isSingleInstanceLockHeld } from '../single-instance-lock';

interface CommandOutput {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Offline transport migration. Never loads defaults, pairs, starts or registers a worker. */
export function runUpdateConnectionCommand(argv: string[], output: CommandOutput = {}): number {
  const stdout = output.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = output.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    const options = parseArgs(argv);
    updateConnection(options.configPath, options.coordinatorUrl);
  } catch {
    // Parser, JSON, filesystem and subprocess exceptions can include credentials.
    stderr('Connection update refused. Use update-connection --config <existing file> --coordinator <wss://address>. Stop the worker and its launcher first; check the file, pairing and permissions. Legacy host/port settings must be migrated before using this command.\n');
    return 1;
  }
  stdout('Connection settings updated. Saved fallback addresses were removed. Restart through the existing launcher and verify the encrypted connection before use.\n');
  return 0;
}

function parseArgs(argv: string[]): { configPath: string; coordinatorUrl: string } {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--config', '--coordinator'].includes(flag) || options.has(flag)
      || !value || value.startsWith('--')) throw new Error('Invalid arguments');
    options.set(flag, value);
  }
  const configPath = options.get('--config');
  const address = options.get('--coordinator');
  if (!configPath || !address || !address.startsWith('wss://') || /[\s\\]/.test(address)) throw new Error('Missing or unsafe arguments');
  const url = new URL(address);
  if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password
    || url.search || url.hash || address.includes('?') || address.includes('#')) {
    throw new Error('An uncredentialed WSS address is required');
  }
  return { configPath: path.resolve(configPath), coordinatorUrl: url.pathname === '/' ? `${url.protocol}//${url.host}` : url.toString() };
}

function updateConnection(configPath: string, coordinatorUrl: string): void {
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe config file');
  const original = fs.readFileSync(configPath, 'utf8');
  const config: unknown = JSON.parse(original.replace(/^\uFEFF/, ''));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid config');
  const saved = config as Record<string, unknown>;
  const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (!nonempty(saved['nodeId']) || !nonempty(saved['coordinatorUrl'])
    || (!nonempty(saved['nodeToken']) && !nonempty(saved['authToken']))
    || (saved['namespace'] !== undefined && !nonempty(saved['namespace']))
    || ['host', 'port', 'requireTls'].some((key) => Object.hasOwn(saved, key))) {
    throw new Error('Expected existing canonical pairing');
  }
  const previous = new URL(saved['coordinatorUrl']);
  if (!['ws:', 'wss:'].includes(previous.protocol)) throw new Error('Invalid existing address');
  const key = `${saved['namespace'] ?? 'default'}:${saved['nodeId']}`;
  // The liveness check also refuses a lock held by this process (useful to callers).
  if (isSingleInstanceLockHeld({ key })) throw new Error('Worker still running');
  const lock = acquireSingleInstanceLock({ key });
  if (!lock) throw new Error('Worker still running');
  try {
    const current = fs.lstatSync(configPath);
    if (!current.isFile() || current.nlink !== 1 || current.ino !== stat.ino || current.dev !== stat.dev
      || fs.readFileSync(configPath, 'utf8') !== original) throw new Error('Config changed during update');
    saved['coordinatorUrl'] = coordinatorUrl;
    delete saved['coordinatorUrls'];
    delete saved['advertisedCoordinatorUrls'];
    replaceConfig(configPath, JSON.stringify(saved, null, 2) + '\n', stat);
  } finally {
    lock.release();
  }
}

function replaceConfig(configPath: string, content: string, stat: fs.Stats): void {
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  if (process.platform === 'win32') {
    // FileStream applies the existing ACL at creation, before any secret bytes
    // are written. File.Replace retains the destination ACL and attributes.
    // Paths travel as environment values, content on stdin, never shell text.
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$stream = $null
$created = $false
try {
  $acl = [System.IO.File]::GetAccessControl($env:AIO_CONNECTION_CONFIG)
  $stream = [System.IO.FileStream]::new($env:AIO_CONNECTION_TEMP, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::Write, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough, $acl)
  $created = $true
  $bytes = [System.Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush($true)
  $stream.Dispose()
  $stream = $null
  [System.IO.File]::Replace($env:AIO_CONNECTION_TEMP, $env:AIO_CONNECTION_CONFIG, $null)
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
  if ($created -and [System.IO.File]::Exists($env:AIO_CONNECTION_TEMP)) { [System.IO.File]::Delete($env:AIO_CONNECTION_TEMP) }
}`;
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        input: content, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15_000, killSignal: 'SIGKILL',
        env: { ...process.env, AIO_CONNECTION_CONFIG: configPath, AIO_CONNECTION_TEMP: temporaryPath },
      });
    } finally {
      // A terminated helper cannot run its PowerShell finally block. Its temp
      // file already has the original ACL; remove it before releasing the lock.
      fs.rmSync(temporaryPath, { force: true });
    }
    return;
  }
  assertNoExtendedAcl(configPath);
  assertNoExtendedAcl(path.dirname(configPath));
  const fd = fs.openSync(temporaryPath, 'wx', 0o600);
  try {
    // Inspect the new inode too, before writing bytes, including inherited ACLs.
    assertNoExtendedAcl(temporaryPath);
    fs.fchownSync(fd, stat.uid, stat.gid);
    fs.fchmodSync(fd, stat.mode & 0o777);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(temporaryPath);
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(temporaryPath, configPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

/** Mode bits alone cannot preserve an extended access policy on a new inode. */
function assertNoExtendedAcl(filePath: string): void {
  const options = { encoding: 'utf8' as const, timeout: 5_000, killSignal: 'SIGKILL' as const, env: { ...process.env, LC_ALL: 'C' } };
  if (process.platform === 'darwin') {
    const listing = execFileSync('/bin/ls', ['-lde', filePath], options);
    if (!/^[-d][rwxStTs-]{9}[@ ]/.test(listing) || /^\s*\d+: /m.test(listing)) {
      throw new Error('Extended access policy cannot be preserved');
    }
    return;
  }
  if (process.platform === 'linux') {
    // Missing getfacl or an unrecognised response must refuse the update, rather
    // than assume this filesystem has no access rules beyond its mode bits.
    const acl = execFileSync('getfacl', ['-cp', '--', filePath], options);
    const entries = acl.trim().split('\n');
    if (entries.length !== 3 || !['user', 'group', 'other'].every((name, index) =>
      new RegExp(`^${name}::[r-][w-][x-]$`).test(entries[index]))) {
      throw new Error('Extended access policy cannot be preserved');
    }
    return;
  }
  throw new Error('Unsupported access policy inspection');
}
