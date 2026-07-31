import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  canonicalizeProjectPluginRoot,
  resolveProjectPluginTrust,
} from './project-plugin-trust';

describe('resolveProjectPluginTrust', () => {
  it('defaults project plugin roots to ask when no trust decision exists', () => {
    const projectRoot = path.resolve(path.join(path.sep, 'repo'));
    const canonical = canonicalizeProjectPluginRoot(projectRoot);

    expect(resolveProjectPluginTrust(projectRoot, {})).toEqual({
      projectRoot: canonical,
      trust: 'ask',
      reason: 'No trust decision recorded for project plugins at this root.',
    });
  });

  it('returns trusted only for a matching canonical project root', () => {
    const projectRoot = path.resolve(path.join(path.sep, 'repo', 'nested', '..'));
    const canonical = canonicalizeProjectPluginRoot(projectRoot);

    expect(resolveProjectPluginTrust(projectRoot, {
      projectPluginTrust: {
        [canonical]: 'trusted',
      },
    })).toEqual({
      projectRoot: canonical,
      trust: 'trusted',
      reason: 'Project plugin root is trusted in settings.',
    });
  });

  it('returns untrusted for an explicit reject decision', () => {
    const projectRoot = path.resolve(path.join(path.sep, 'repo'));
    const canonical = canonicalizeProjectPluginRoot(projectRoot);

    expect(resolveProjectPluginTrust(projectRoot, {
      projectPluginTrust: {
        [projectRoot]: 'untrusted',
      },
    })).toMatchObject({
      projectRoot: canonical,
      trust: 'untrusted',
      reason: 'Project plugin root is rejected in settings.',
    });
  });

  it('ignores malformed trust maps and falls back to ask', () => {
    const projectRoot = path.resolve(path.join(path.sep, 'repo'));
    const canonical = canonicalizeProjectPluginRoot(projectRoot);

    expect(resolveProjectPluginTrust(projectRoot, {
      projectPluginTrust: {
        [projectRoot]: 'yes-please',
      },
    })).toMatchObject({
      projectRoot: canonical,
      trust: 'ask',
    });
  });
});

describe('canonicalizeProjectPluginRoot — symlink resolution (2026-07-31 fresh-eyes hardening)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    tmpDirs.push(dir);
    return fs.realpathSync(dir);
  }

  it('a symlink alias of the TRUSTED directory resolves to the same canonical root', () => {
    const trustedDir = makeTmpDir('project-plugin-trust-trusted');
    const aliasPath = path.join(os.tmpdir(), `plugin-trust-alias-${Date.now()}`);
    fs.symlinkSync(trustedDir, aliasPath, 'dir');
    tmpDirs.push(aliasPath);

    try {
      expect(canonicalizeProjectPluginRoot(aliasPath)).toBe(canonicalizeProjectPluginRoot(trustedDir));

      const decision = resolveProjectPluginTrust(aliasPath, {
        projectPluginTrust: { [trustedDir]: 'trusted' },
      });
      expect(decision.trust).toBe('trusted');
    } finally {
      fs.rmSync(aliasPath, { force: true });
    }
  });

  it('a symlink alias of an UNTRUSTED directory does not inherit a differently-named trusted root', () => {
    const trustedDir = makeTmpDir('project-plugin-trust-approved');
    const untrustedDir = makeTmpDir('project-plugin-trust-other');
    const aliasToUntrusted = path.join(os.tmpdir(), `plugin-trust-alias-other-${Date.now()}`);
    fs.symlinkSync(untrustedDir, aliasToUntrusted, 'dir');
    tmpDirs.push(aliasToUntrusted);

    try {
      expect(canonicalizeProjectPluginRoot(aliasToUntrusted)).not.toBe(canonicalizeProjectPluginRoot(trustedDir));

      const decision = resolveProjectPluginTrust(aliasToUntrusted, {
        projectPluginTrust: { [trustedDir]: 'trusted' },
      });
      expect(decision.trust).toBe('ask'); // not 'trusted' — no inherited approval
    } finally {
      fs.rmSync(aliasToUntrusted, { force: true });
    }
  });

  it('fails closed (falls back to the plain-resolved form) for a path that does not exist', () => {
    const missing = path.join(os.tmpdir(), `plugin-trust-does-not-exist-${Date.now()}`);
    expect(() => canonicalizeProjectPluginRoot(missing)).not.toThrow();
    expect(canonicalizeProjectPluginRoot(missing)).toBe(path.resolve(missing));
  });
});
