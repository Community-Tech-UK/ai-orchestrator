import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { normalizedCommandBasename } from '../main/app/run-on-node-posix-policy';

export type TrustedNodeExecCommandId =
  | 'curl'
  | 'powershell'
  | 'taskkill';

export interface TrustedNodeExecResolverRuntime {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly lstatPath: (
    path: string,
  ) => Promise<Pick<Stats, 'isDirectory' | 'isFile' | 'isSymbolicLink' | 'mode' | 'uid'>>;
  readonly realpathPath: (path: string) => Promise<string>;
  readonly inspectWindowsAcl?: WindowsAclInspector;
}

interface WindowsAclRule {
  readonly appliesToObject: boolean;
  readonly sid: string;
  readonly type: 'Allow' | 'Deny';
  readonly rights: number;
}

interface WindowsAclRecord {
  readonly daclNull: boolean;
  readonly daclPresent: boolean;
  readonly path: string;
  readonly ownerSid: string;
  readonly rules: WindowsAclRule[];
}

type WindowsAclInspector = (
  executablePath: string,
  parentPath: string,
  bootstrapPowerShellPath: string,
  systemRoot: string,
) => Promise<unknown>;

export type TrustedNodeExecExecutableResolver = (
  requestedExecutable: string,
) => Promise<string>;

const DEFAULT_RUNTIME: TrustedNodeExecResolverRuntime = {
  get platform() {
    return process.platform;
  },
  get env() {
    return process.env;
  },
  lstatPath: lstat,
  realpathPath: realpath,
  inspectWindowsAcl,
};

const TRUSTED_WINDOWS_OWNER_SIDS = new Set([
  'S-1-5-18',
  'S-1-5-32-544',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',
]);
const WINDOWS_WRITE_CAPABLE_RIGHTS = (
  0x00000002 // FILE_WRITE_DATA / FILE_ADD_FILE
  | 0x00000004 // FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY
  | 0x00000010 // FILE_WRITE_EA
  | 0x00000040 // FILE_DELETE_CHILD
  | 0x00000100 // FILE_WRITE_ATTRIBUTES
  | 0x00010000 // DELETE
  | 0x00040000 // WRITE_DAC
  | 0x00080000 // WRITE_OWNER
  | 0x02000000 // MAXIMUM_ALLOWED (indeterminate maximum access)
  | 0x10000000 // GENERIC_ALL
  | 0x40000000 // GENERIC_WRITE
);
/**
 * Budget for one ACL inspection child process. Was 1s, which a healthy run
 * very nearly missed: the working inspection measured 690 ms on windows-pc
 * (2026-09-21), leaving 310 ms of headroom on an idle box. Since the child is
 * SIGKILLed on expiry and every exec_on_node call depends on it, a loaded
 * machine would have turned this into an intermittent, misleading
 * "inspection failed or was unavailable". Bare PowerShell spawn alone is
 * ~156 ms there.
 */
const WINDOWS_ACL_TIMEOUT_MS = 5_000;
const WINDOWS_ACL_MAX_OUTPUT_BYTES = 64 * 1024;

export async function resolveTrustedNodeExecExecutable(
  requestedExecutable: string,
  runtime: TrustedNodeExecResolverRuntime = DEFAULT_RUNTIME,
): Promise<string> {
  const commandId = commandIdFor(requestedExecutable);
  const candidate = runtime.platform === 'win32'
    ? windowsCommandPath(commandId, runtime.env)
    : posixCommandPath(commandId);
  const parent = runtime.platform === 'win32'
    ? win32.dirname(candidate)
    : posix.dirname(candidate);
  await assertTrustedPathShape(candidate, parent, runtime);
  if (runtime.platform === 'win32') {
    const systemRoot = validatedWindowsSystemRoot(runtime.env);
    const bootstrap = windowsCommandPath('powershell', runtime.env);
    if (bootstrap !== candidate) {
      await assertRegularCanonicalPath(bootstrap, runtime);
    }
    let inspected: unknown;
    try {
      inspected = await (runtime.inspectWindowsAcl ?? inspectWindowsAcl)(
        candidate,
        parent,
        bootstrap,
        systemRoot,
      );
    } catch {
      throw new Error('trusted Windows ACL inspection failed or was unavailable');
    }
    assertTrustedWindowsAcl(inspected, candidate, parent);
  }
  return candidate;
}

function commandIdFor(requestedExecutable: string): TrustedNodeExecCommandId {
  const basename = normalizedCommandBasename(requestedExecutable);
  if (basename === 'curl' || basename === 'curl.exe') return 'curl';
  if (basename === 'powershell' || basename === 'powershell.exe') return 'powershell';
  if (basename === 'taskkill' || basename === 'taskkill.exe') return 'taskkill';
  throw new Error('node.exec executable is not registered for trusted system resolution');
}

function windowsCommandPath(
  commandId: TrustedNodeExecCommandId,
  env: NodeJS.ProcessEnv,
): string {
  const systemRoot = validatedWindowsSystemRoot(env);
  if (commandId === 'powershell') {
    return win32.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
  }
  return win32.join(systemRoot, 'System32', `${commandId}.exe`);
}

function validatedWindowsSystemRoot(env: NodeJS.ProcessEnv): string {
  const rawSystemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'];
  if (!rawSystemRoot || !/^[a-z]:\\windows\\?$/iu.test(rawSystemRoot)) {
    throw new Error('Windows SystemRoot is unavailable or is not a trusted system location');
  }
  const systemRoot = win32.normalize(rawSystemRoot);
  const windir = env['WINDIR'];
  if (windir && win32.normalize(windir).toLowerCase() !== systemRoot.toLowerCase()) {
    throw new Error('Windows SystemRoot and WINDIR do not identify the same system location');
  }
  return systemRoot;
}

function posixCommandPath(commandId: TrustedNodeExecCommandId): string {
  if (commandId !== 'curl') {
    throw new Error(`node.exec ${commandId} is not available on this worker platform`);
  }
  return posix.join('/usr/bin', 'curl');
}

async function assertTrustedPathShape(
  candidate: string,
  parent: string,
  runtime: TrustedNodeExecResolverRuntime,
): Promise<void> {
  let candidateMetadata: Awaited<ReturnType<TrustedNodeExecResolverRuntime['lstatPath']>>;
  let parentMetadata: Awaited<ReturnType<TrustedNodeExecResolverRuntime['lstatPath']>>;
  let canonicalCandidate: string;
  let canonicalParent: string;
  try {
    [candidateMetadata, parentMetadata, canonicalCandidate, canonicalParent] = await Promise.all([
      runtime.lstatPath(candidate),
      runtime.lstatPath(parent),
      runtime.realpathPath(candidate),
      runtime.realpathPath(parent),
    ]);
  } catch {
    throw new Error('trusted node.exec executable or fixed parent is missing or unreadable');
  }
  if (!candidateMetadata.isFile() || candidateMetadata.isSymbolicLink()) {
    throw new Error('trusted node.exec system executable is not a regular non-symlink file');
  }
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error('trusted node.exec fixed parent is not a non-symlink directory');
  }
  if (!sameCanonicalPath(canonicalCandidate, candidate, runtime.platform)
    || !sameCanonicalPath(canonicalParent, parent, runtime.platform)) {
    throw new Error('trusted node.exec executable or parent resolved outside its fixed location');
  }
  if (runtime.platform !== 'win32') {
    if (candidateMetadata.uid !== 0 || parentMetadata.uid !== 0) {
      throw new Error('trusted node.exec executable and parent must be owned by root');
    }
    if ((candidateMetadata.mode & 0o022) !== 0 || (parentMetadata.mode & 0o022) !== 0) {
      throw new Error('trusted node.exec executable and parent must not be group/world writable');
    }
  }
}

async function assertRegularCanonicalPath(
  candidate: string,
  runtime: TrustedNodeExecResolverRuntime,
): Promise<void> {
  try {
    const [metadata, canonical] = await Promise.all([
      runtime.lstatPath(candidate),
      runtime.realpathPath(candidate),
    ]);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || !sameCanonicalPath(canonical, candidate, runtime.platform)) {
      throw new Error('invalid bootstrap');
    }
  } catch {
    throw new Error('trusted Windows ACL bootstrap is missing or has an unstable path');
  }
}

function sameCanonicalPath(
  canonical: string,
  expected: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === 'win32'
    ? win32.normalize(canonical).toLowerCase() === win32.normalize(expected).toLowerCase()
    : canonical === expected;
}

function assertTrustedWindowsAcl(
  inspected: unknown,
  candidate: string,
  parent: string,
): void {
  if (!Array.isArray(inspected) || inspected.length !== 2) {
    throw new Error('trusted Windows ACL inspection returned malformed records');
  }
  const expected = new Map([
    [win32.normalize(candidate).toLowerCase(), candidate],
    [win32.normalize(parent).toLowerCase(), parent],
  ]);
  for (const value of inspected) {
    const record = parseWindowsAclRecord(value);
    const key = win32.normalize(record.path).toLowerCase();
    if (!expected.delete(key)) {
      throw new Error('trusted Windows ACL inspection returned a mismatched path');
    }
    if (!TRUSTED_WINDOWS_OWNER_SIDS.has(record.ownerSid)) {
      throw new Error('trusted Windows executable or parent has an untrusted owner SID');
    }
    if (!record.daclPresent || record.daclNull) {
      throw new Error('trusted Windows executable or parent has an absent or NULL DACL');
    }
    if (record.rules.some((rule) => (
      rule.appliesToObject
      && rule.type === 'Allow'
      && !TRUSTED_WINDOWS_OWNER_SIDS.has(rule.sid)
      && (rule.rights & WINDOWS_WRITE_CAPABLE_RIGHTS) !== 0
    ))) {
      throw new Error('trusted Windows executable or parent is writable by an untrusted principal');
    }
  }
  if (expected.size !== 0) {
    throw new Error('trusted Windows ACL inspection omitted an expected path');
  }
}

function parseWindowsAclRecord(value: unknown): WindowsAclRecord {
  if (!isRecord(value) || typeof value['daclNull'] !== 'boolean'
    || typeof value['daclPresent'] !== 'boolean' || typeof value['path'] !== 'string'
    || typeof value['ownerSid'] !== 'string' || !Array.isArray(value['rules'])) {
    throw new Error('trusted Windows ACL inspection returned a malformed record');
  }
  const rules = value['rules'].map((rule): WindowsAclRule => {
    if (!isRecord(rule) || typeof rule['appliesToObject'] !== 'boolean'
      || typeof rule['sid'] !== 'string'
      || (rule['type'] !== 'Allow' && rule['type'] !== 'Deny')
      || !Number.isSafeInteger(rule['rights']) || (rule['rights'] as number) < 0
      || (rule['rights'] as number) > 0xffffffff) {
      throw new Error('trusted Windows ACL inspection returned a malformed access rule');
    }
    return {
      appliesToObject: rule['appliesToObject'],
      sid: rule['sid'],
      type: rule['type'],
      rights: rule['rights'] as number,
    };
  });
  return {
    daclNull: value['daclNull'],
    daclPresent: value['daclPresent'],
    path: value['path'],
    ownerSid: value['ownerSid'],
    rules,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inspectWindowsAcl(
  executablePath: string,
  parentPath: string,
  bootstrapPowerShellPath: string,
  systemRoot: string,
): Promise<unknown> {
  const script = buildWindowsAclInspectionScript(executablePath, parentPath);
  return new Promise((resolveResult, rejectResult) => {
    execFile(
      bootstrapPowerShellPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        env: {
          PATH: win32.join(systemRoot, 'System32'),
          PSModulePath: win32.join(
            systemRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'Modules',
          ),
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
        },
        killSignal: 'SIGKILL',
        maxBuffer: WINDOWS_ACL_MAX_OUTPUT_BYTES,
        timeout: WINDOWS_ACL_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          rejectResult(error);
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          rejectResult(parseError);
        }
      },
    );
  });
}

export function buildWindowsAclInspectionScript(
  executablePath: string,
  parentPath: string,
): string {
  const paths = [executablePath, parentPath]
    .map((value) => `'${value.replace(/'/gu, "''")}'`)
    .join(',');
  return [
    "$ErrorActionPreference='Stop'",
    `$paths=@(${paths})`,
    '$records=@(foreach($path in $paths){',
    '$acl=Get-Acl -LiteralPath $path',
    '$raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)',
    '[pscustomobject]@{',
    'daclPresent=(($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0)',
    'daclNull=($null -eq $raw.DiscretionaryAcl)',
    'path=$path',
    'ownerSid=($acl.GetOwner([System.Security.Principal.SecurityIdentifier])).Value',
    'rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object{',
    '[pscustomobject]@{appliesToObject=(($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0);sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=([int64]$_.FileSystemRights -band 0xffffffffL)}',
    '})',
    '}',
    '})',
    'ConvertTo-Json -InputObject $records -Compress -Depth 5',
    // Newline, NOT ';'. One of the lines above opens a hash literal
    // (`[pscustomobject]@{`), and a semicolon joiner put a `;` immediately
    // after that brace — `@{;daclPresent=...` — which PowerShell rejects with
    // "The hash literal was incomplete". The child then exited 1 with empty
    // stdout, JSON.parse('') threw, and inspectWindowsAcl's catch-all reported
    // "trusted Windows ACL inspection failed or was unavailable", so NO
    // exec_on_node call could run on Windows at all.
    //
    // Measured on windows-pc 2026-09-21: semicolon join exit 1 / 0 chars;
    // newline join exit 0 / 2004 chars of valid JSON (2 records).
    //
    // The unit tests never caught it because they inject a fake
    // inspectWindowsAcl, so this string was built but never executed.
  ].join('\n');
}
