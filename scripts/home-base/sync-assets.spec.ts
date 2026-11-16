import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
interface Asset { path: string; base64: string }
interface Transfer { version: number; files: unknown[]; assets: Asset[]; links: unknown[]; exclusions: string[] }
const { buildSyncPackage, applySyncPackage } = require('./sync-agent-setup.js') as {
  buildSyncPackage(options: { sourceHome: string }): Transfer;
  applySyncPackage(pkg: Transfer, options: { destinationHome: string }): unknown;
};
const roots: string[] = [];
const home = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-sync-asset-')); roots.push(dir); return dir; };
const write = (root: string, relative: string, content: Buffer | string) => {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
};
const icon = fs.readFileSync(new URL('./fixtures/pdf-icon.png', import.meta.url));
const iconPath = '.codex/skills/pdf/assets/pdf.png';
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('reviewed home-base setup assets', () => {
  it('preserves the reviewed PDF icon bytes through actual source and destination processing', () => {
    const source = home(); const destination = home();
    write(source, iconPath, icon);
    const pkg = buildSyncPackage({ sourceHome: source });
    expect(pkg.assets).toEqual([{ path: iconPath, base64: icon.toString('base64') }]);
    expect(pkg.files).toEqual([]);
    applySyncPackage(pkg, { destinationHome: destination });
    expect(fs.readFileSync(path.join(destination, iconPath))).toEqual(icon);
    expect(fs.statSync(path.join(destination, iconPath)).mode & 0o777).toBe(0o600);
  });

  it('refuses a changed reviewed source asset and unknown binary paths', () => {
    const source = home();
    const changed = Buffer.from(icon); changed[changed.length - 1] ^= 1;
    write(source, iconPath, changed);
    expect(() => buildSyncPackage({ sourceHome: source })).toThrow(/reviewed asset/);
    fs.unlinkSync(path.join(source, iconPath));
    write(source, '.codex/skills/other/assets/pdf.png', icon);
    expect(() => buildSyncPackage({ sourceHome: source })).toThrow(/non-text/);
  });

  it.each(['changed', 'unknown-path', 'invalid-base64', 'oversized', 'extra-field'])('rejects %s incoming assets before any setup write', kind => {
    const source = home(); const destination = home();
    write(source, '.agents/AGENTS.md', '# New rules');
    const pkg = buildSyncPackage({ sourceHome: source });
    const asset = { path: iconPath, base64: icon.toString('base64') };
    if (kind === 'changed') { const changed = Buffer.from(icon); changed[0] = 0; asset.base64 = changed.toString('base64'); }
    if (kind === 'unknown-path') asset.path = '.codex/skills/other/assets/pdf.png';
    if (kind === 'invalid-base64') asset.base64 += '!';
    if (kind === 'oversized') asset.base64 += 'AAAA';
    pkg.assets = [kind === 'extra-field' ? { ...asset, unknown: true } as Asset : asset];
    expect(() => applySyncPackage(pkg, { destinationHome: destination })).toThrow(/reviewed asset/);
    expect(fs.existsSync(path.join(destination, '.agents/AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(destination, iconPath))).toBe(false);
  });

  it('omits the icon too when its entire skill is prohibited', () => {
    const source = home();
    write(source, iconPath, icon);
    write(source, '.codex/skills/pdf/z-guide.md', '# Use computer.click to control the window.');
    const pkg = buildSyncPackage({ sourceHome: source });
    expect(pkg.assets).toEqual([]);
    expect(pkg.files).toEqual([]);
    expect(pkg.exclusions).toContain('.codex/skills/pdf');
  });

  it.each(['asset-file', 'asset-directory', 'text-file'])('preserves local account state when an incoming %s aliases it', kind => {
    const source = home(); const destination = home();
    write(source, '.agents/AGENTS.md', '# New rules');
    write(source, iconPath, icon);
    const original = JSON.stringify({ oauthAccount: { value: 'EXAMPLE_LOCAL_LOGIN' } });
    write(destination, '.claude.json', original);
    if (kind === 'asset-file') {
      fs.mkdirSync(path.dirname(path.join(destination, iconPath)), { recursive: true });
      fs.symlinkSync(path.join(destination, '.claude.json'), path.join(destination, iconPath));
    } else if (kind === 'asset-directory') {
      fs.mkdirSync(path.join(destination, '.codex/skills/pdf'), { recursive: true });
      fs.mkdirSync(path.join(destination, 'redirected-assets'));
      fs.symlinkSync(path.join(destination, 'redirected-assets'), path.join(destination, '.codex/skills/pdf/assets'), 'dir');
    } else {
      fs.mkdirSync(path.join(destination, '.agents'), { recursive: true });
      fs.symlinkSync(path.join(destination, '.claude.json'), path.join(destination, '.agents/AGENTS.md'));
    }
    expect(() => applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination })).toThrow(/alias|symlink/);
    expect(fs.readFileSync(path.join(destination, '.claude.json'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(destination, 'redirected-assets/pdf.png'))).toBe(false);
  });

  it('retains an intentional shared skill directory without changing local sign-in state', () => {
    const source = home(); const destination = home();
    const relative = '.codex/skills/reports/SKILL.md';
    write(source, relative, '# Safe report guidance');
    write(destination, '.agents/skills/reports/SKILL.md', '# Previous guidance');
    fs.mkdirSync(path.join(destination, '.codex/skills'), { recursive: true });
    fs.symlinkSync(path.join(destination, '.agents/skills/reports'), path.join(destination, '.codex/skills/reports'), 'dir');
    const original = JSON.stringify({ oauthAccount: { value: 'EXAMPLE_LOCAL_LOGIN' } });
    write(destination, '.claude.json', original);
    applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination });
    expect(fs.lstatSync(path.join(destination, '.codex/skills/reports')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(destination, relative), 'utf8')).toBe('# Safe report guidance');
    expect(fs.readFileSync(path.join(destination, '.agents/skills/reports/SKILL.md'), 'utf8')).toBe('# Safe report guidance');
    expect(JSON.parse(fs.readFileSync(path.join(destination, '.claude.json'), 'utf8')).oauthAccount).toEqual({ value: 'EXAMPLE_LOCAL_LOGIN' });
  });
});
