import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface BrowserUploadPolicyInput {
  filePath: string;
  workspaceRoots: string[];
  approvedRoots?: string[];
  userDataPath: string;
  profileRoot: string;
  autonomous?: boolean;
}

export interface BrowserUploadPolicyResult {
  allowed: boolean;
  reason?:
    | 'file_not_found'
    | 'browser_profile_path_blocked'
    | 'secret_file_blocked'
    | 'root_not_allowed'
    | 'hardlink_requires_per_action_approval';
  requiresPerActionApproval?: boolean;
  resolvedPath?: string;
  detectedFileType?: string;
}

const SECRET_FILENAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'known_hosts',
  'cookies',
  'login keychain',
]);

export function validateBrowserUploadPath(
  input: BrowserUploadPolicyInput,
): BrowserUploadPolicyResult {
  const expanded = expandPath(input.filePath);
  let resolvedPath: string;
  let stat: fs.Stats;
  try {
    resolvedPath = fs.realpathSync(expanded);
    stat = fs.statSync(resolvedPath);
  } catch {
    return { allowed: false, reason: 'file_not_found' };
  }

  const detectedFileType = detectFileType(resolvedPath);
  const profileRoot = resolveExistingOrAbsolute(input.profileRoot);
  const userDataPath = resolveExistingOrAbsolute(input.userDataPath);
  if (isWithin(resolvedPath, profileRoot)) {
    return {
      allowed: false,
      reason: 'browser_profile_path_blocked',
      resolvedPath,
      detectedFileType,
    };
  }
  if (isSecretPath(resolvedPath) || isWithin(resolvedPath, userDataPath) && !isAllowedRoot(resolvedPath, input)) {
    return {
      allowed: false,
      reason: 'secret_file_blocked',
      resolvedPath,
      detectedFileType,
    };
  }
  if (!isAllowedRoot(resolvedPath, input)) {
    return {
      allowed: false,
      reason: 'root_not_allowed',
      resolvedPath,
      detectedFileType,
    };
  }
  if (input.autonomous && stat.nlink > 1) {
    return {
      allowed: false,
      reason: 'hardlink_requires_per_action_approval',
      requiresPerActionApproval: true,
      resolvedPath,
      detectedFileType,
    };
  }

  return {
    allowed: true,
    resolvedPath,
    detectedFileType,
  };
}

function isAllowedRoot(resolvedPath: string, input: BrowserUploadPolicyInput): boolean {
  return [...input.workspaceRoots, ...(input.approvedRoots ?? [])]
    .map(resolveExistingOrAbsolute)
    .some((root) => isWithin(resolvedPath, root));
}

function resolveExistingOrAbsolute(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function expandPath(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isSecretPath(resolvedPath: string): boolean {
  const basename = path.basename(resolvedPath).toLowerCase();
  return SECRET_FILENAMES.has(basename) || basename.endsWith('.pem') || basename.endsWith('.key');
}

function detectFileType(filePath: string): string {
  const buffer = Buffer.alloc(8);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return 'image/png';
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return 'application/zip';
  }
  if (buffer.subarray(0, 4).toString('utf-8') === '%PDF') {
    return 'application/pdf';
  }
  return 'application/octet-stream';
}
