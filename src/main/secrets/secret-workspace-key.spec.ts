import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NO_WORKSPACE_KEY, isUnscopedWorkspace, toSecretWorkspaceId } from './secret-workspace-key';
import { toWorkspaceId } from '../../shared/utils/workspace-key';

const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';

// A real directory on disk, because realpath resolution cannot be exercised against
// a fictional path — the try/catch would swallow the interesting behaviour.
const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-secret-ws-'));

afterAll(() => {
  fs.rmSync(realDir, { recursive: true, force: true });
});

describe('toSecretWorkspaceId', () => {
  it('maps blank input to the sentinel', () => {
    expect(toSecretWorkspaceId('')).toBe(NO_WORKSPACE_KEY);
    expect(toSecretWorkspaceId('   ')).toBe(NO_WORKSPACE_KEY);
    expect(toSecretWorkspaceId(null)).toBe(NO_WORKSPACE_KEY);
    expect(toSecretWorkspaceId(undefined)).toBe(NO_WORKSPACE_KEY);
  });

  it('collapses trailing separators, "." and ".." to one id', () => {
    const base = toSecretWorkspaceId(realDir);

    expect(toSecretWorkspaceId(`${realDir}${path.sep}`)).toBe(base);
    expect(toSecretWorkspaceId(path.join(realDir, '.'))).toBe(base);
    expect(toSecretWorkspaceId(path.join(realDir, 'sub', '..'))).toBe(base);
  });

  it('resolves a symlink to the same id as its target', () => {
    const target = path.join(realDir, 'target');
    const link = path.join(realDir, 'link');
    fs.mkdirSync(target, { recursive: true });
    try {
      fs.symlinkSync(target, link, 'dir');
    } catch {
      // Symlink creation can be denied (e.g. unprivileged Windows). Skip rather than
      // assert a weaker property that would pass for the wrong reason.
      return;
    }

    expect(toSecretWorkspaceId(link)).toBe(toSecretWorkspaceId(target));
  });

  it('still normalises a path that does not exist', () => {
    const ghost = path.join(realDir, 'does-not-exist');

    expect(toSecretWorkspaceId(`${ghost}${path.sep}`)).toBe(toSecretWorkspaceId(ghost));
    expect(toSecretWorkspaceId(ghost)).not.toBe(NO_WORKSPACE_KEY);
  });

  it('folds case only on case-insensitive filesystems', () => {
    const id = toSecretWorkspaceId(realDir);

    if (caseInsensitive) {
      expect(id).toBe(id.toLowerCase());
    } else {
      // On Linux /A and /a are different directories; folding them together would
      // merge two distinct workspaces into one credential scope.
      expect(toSecretWorkspaceId('/Abc')).not.toBe(toSecretWorkspaceId('/abc'));
    }
  });

  it('is stricter than toWorkspaceId, which is why it exists', () => {
    const withSlash = `${realDir}${path.sep}`;

    // The loose grouping key splits these two forms of the same directory...
    expect(toWorkspaceId(withSlash)).not.toBe(toWorkspaceId(realDir));
    // ...while the secret key unifies them.
    expect(toSecretWorkspaceId(withSlash)).toBe(toSecretWorkspaceId(realDir));
  });
});

describe('isUnscopedWorkspace', () => {
  it('identifies the sentinel scope', () => {
    expect(isUnscopedWorkspace(NO_WORKSPACE_KEY)).toBe(true);
    expect(isUnscopedWorkspace(toSecretWorkspaceId(realDir))).toBe(false);
  });
});
