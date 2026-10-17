import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../providers/opencode-credential-names', () => ({ readOpenCodeV2CredentialNames: () => ['xiaomi-token-plan-sgp', 'aio-mimo-account-b'] }));
import { readOpenCodeAuthCredentialNames } from '../settings-migrations-provider-accounts';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
it.each([
  ['malformed', '{'], ['nonobject', 'null'], ['array', '[]'], ['oversized', ' '.repeat(256 * 1024 + 1)],
])('keeps version 2 credential identities when legacy auth is %s', (_name, content) => {
  const root = mkdtempSync(join(tmpdir(), 'aio-opencode-migration-')); roots.push(root);
  mkdirSync(join(root, 'opencode'));
  writeFileSync(join(root, 'opencode', 'auth.json'), content);
  vi.stubEnv('XDG_DATA_HOME', root);
  expect(readOpenCodeAuthCredentialNames()).toEqual(['xiaomi-token-plan-sgp']);
});
it('unions valid legacy names with database identities without exposing values', () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-opencode-migration-')); roots.push(root);
  mkdirSync(join(root, 'opencode'));
  writeFileSync(join(root, 'opencode', 'auth.json'), JSON.stringify({ 'xiaomi-token-plan-ams': { type: 'api', key: 'placeholder-not-a-real-key' } }));
  vi.stubEnv('XDG_DATA_HOME', root);
  expect(readOpenCodeAuthCredentialNames().sort()).toEqual(['xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp']);
});
