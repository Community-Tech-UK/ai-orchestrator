import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, SourceUpdateConfig } from './source-update-types';
const require = createRequire(import.meta.url);
const { createPackage } = require('@electron/asar') as { createPackage: (source: string, archive: string) => Promise<void> };
const verifier = () => require('./source-update-build.cjs') as { verifyApp: (config: SourceUpdateConfig, app: string, commit: string, run: Run) => Promise<void> };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
async function fixture(options: { dirty?: boolean; runtime?: boolean; commit?: string } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'source-signature-'))); roots.push(root);
  const appPath = path.join(root, 'Harness.app'); const candidate = path.join(root, 'candidate.app');
  mkdirSync(appPath); mkdirSync(path.join(candidate, 'Contents/Resources/desktop-helper'), { recursive: true });
  const contents = path.join(root, 'contents'); mkdirSync(path.join(contents, 'dist/main/updates'), { recursive: true });
  const commit = 'b'.repeat(40);
  writeFileSync(path.join(contents, 'dist/build-info.json'), JSON.stringify({ commit: options.commit ?? commit, branch: 'main', dirty: options.dirty ?? false }));
  if (options.runtime !== false) writeFileSync(path.join(contents, 'dist/main/updates/source-update-runtime.js'), 'module.exports = {};');
  await createPackage(contents, path.join(candidate, 'Contents/Resources/app.asar'));
  const config: SourceUpdateConfig = { version: 1, repositoryPath: root, remote: 'origin', branch: 'main', appPath, nodePath: process.execPath, driverPath: path.join(root, 'driver.cjs'), stateDirectory: root };
  const calls: string[][] = [];
  const run: Run = async (file, args) => { calls.push([file, ...args]); return { code: 0, stdout: '', stderr: 'TeamIdentifier=TEAM123456\nIdentifier=com.ai.orchestrator\n' }; };
  return { root, config, candidate, commit, calls, run };
}
describe('signed source candidate verification', () => {
  it('verifies complete signatures, matching app/helper Team IDs and the packaged source stamp', async () => {
    const f = await fixture(); await verifier().verifyApp(f.config, f.candidate, f.commit, f.run);
    expect(f.calls.filter(call => call[1] === '--verify')).toHaveLength(3);
    expect(f.calls.every(call => call[0] === '/usr/bin/codesign')).toBe(true);
  });
  it('rejects broken signatures and another signing team', async () => {
    const f = await fixture();
    await expect(verifier().verifyApp(f.config, f.candidate, f.commit, async () => ({ code: 1, stdout: '', stderr: 'placeholder' }))).rejects.toThrow('signature');
    const different: Run = async (_file, args) => ({ code: 0, stdout: '', stderr: `Identifier=com.ai.orchestrator\nTeamIdentifier=${args.at(-1) === f.candidate ? 'OTHER12345' : 'TEAM123456'}\n` });
    await expect(verifier().verifyApp(f.config, f.candidate, f.commit, different)).rejects.toThrow('identities');
  });
  it('rejects dirty, mismatched or missing stamped source and missing updater runtime', async () => {
    for (const options of [{ dirty: true }, { commit: 'a'.repeat(40) }, { runtime: false }]) {
      const f = await fixture(options);
      await expect(verifier().verifyApp(f.config, f.candidate, f.commit, f.run)).rejects.toThrow(/stamp|runtime/u);
    }
  });
});
