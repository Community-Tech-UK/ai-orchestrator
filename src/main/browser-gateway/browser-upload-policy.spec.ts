import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateBrowserUploadPath } from './browser-upload-policy';

describe('browser-upload-policy', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let userDataPath: string;
  let profileRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-policy-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    userDataPath = path.join(tempDir, 'userData');
    profileRoot = path.join(userDataPath, 'browser-profiles');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(profileRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('allows workspace files after symlink resolution and detects magic-byte file type', () => {
    const realFile = path.join(workspaceRoot, 'image.png');
    const symlink = path.join(tempDir, 'linked.png');
    fs.writeFileSync(realFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
    fs.symlinkSync(realFile, symlink);

    expect(
      validateBrowserUploadPath({
        filePath: symlink,
        workspaceRoots: [workspaceRoot],
        userDataPath,
        profileRoot,
      }),
    ).toMatchObject({
      allowed: true,
      resolvedPath: fs.realpathSync(realFile),
      detectedFileType: 'image/png',
    });
  });

  it('blocks secrets and browser profile files', () => {
    const secret = path.join(workspaceRoot, '.env');
    const profileFile = path.join(profileRoot, 'profile-1', 'Cookies');
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(secret, 'TOKEN=secret');
    fs.writeFileSync(profileFile, 'cookies');

    expect(
      validateBrowserUploadPath({
        filePath: secret,
        workspaceRoots: [workspaceRoot],
        userDataPath,
        profileRoot,
      }),
    ).toMatchObject({ allowed: false, reason: 'secret_file_blocked' });
    expect(
      validateBrowserUploadPath({
        filePath: profileFile,
        workspaceRoots: [workspaceRoot],
        userDataPath,
        profileRoot,
      }),
    ).toMatchObject({ allowed: false, reason: 'browser_profile_path_blocked' });
  });

  it('requires per-action approval for hardlinked files under autonomous grants', () => {
    const source = path.join(workspaceRoot, 'build.aab');
    const hardlink = path.join(workspaceRoot, 'linked.aab');
    fs.writeFileSync(source, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    fs.linkSync(source, hardlink);

    expect(
      validateBrowserUploadPath({
        filePath: hardlink,
        workspaceRoots: [workspaceRoot],
        userDataPath,
        profileRoot,
        autonomous: true,
      }),
    ).toMatchObject({
      allowed: false,
      reason: 'hardlink_requires_per_action_approval',
      requiresPerActionApproval: true,
      detectedFileType: 'application/zip',
    });
  });
});
