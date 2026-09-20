import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserCreateGrantRequest } from '@contracts/types/browser';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserGrantStore } from './browser-grant-store';
import { makeProfile, makeService } from './browser-gateway-service.test-helpers';

const cleanups: (() => void)[] = [];
const scenarios = [
  { existing: false, nodeId: 'local' }, { existing: true, nodeId: 'local' },
  { existing: false, nodeId: 'windows-pc' }, { existing: true, nodeId: 'windows-pc' },
];

function fixture(existing: boolean, nodeId = 'local') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-persistent-upload-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const profileRoot = path.join(root, 'userData', 'profile-1');
  for (const directory of [first, second, profileRoot]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'artifact.txt'), 'test');
  }
  const db = defaultDriverFactory(':memory:');
  cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  createTables(db); createMigrationsTable(db); runMigrations(db);
  const store = new BrowserGrantStore(db);
  const profile = makeProfile({ userDataDir: profileRoot, executionNodeId: nodeId === 'local' ? undefined : nodeId });
  const profileId = nodeId === 'local' ? 'existing-tab:7:42' : `existing-tab:n.${nodeId}:7:42`;
  const tab = { profileId, targetId: `${profileId}:target`, title: 'Upload',
    url: 'http://localhost:4567/upload', origin: 'http://localhost:4567',
    nodeId: nodeId === 'local' ? undefined : nodeId, allowedOrigins: profile.allowedOrigins };
  const sendCommand = vi.fn(async (request: { payload?: Record<string, unknown> }) => {
    const filePath = request.payload?.['filePath'] as string;
    return { uploaded: true, fileCount: 1, files: [{ name: path.basename(filePath), size: fs.statSync(filePath).size }] };
  });
  const f = makeService({ profile: existing ? null : profile, existingTab: existing ? tab : undefined,
    extensionCommandStore: { sendCommand },
    stageUploadFileOnNode: async (_node, localPath) => ({ remotePath: localPath,
      size: fs.statSync(localPath).size, sha256: 'placeholder', integrity: 'size-and-sha256' }),
  });
  Object.assign(f.grantStore, {
    listGrants: store.listGrants.bind(store), createGrant: store.createGrant.bind(store),
    consumeGrant: store.consumeGrant.bind(store), revokeGrant: store.revokeGrant.bind(store),
  });
  const request = { profileId: existing ? tab.profileId : profile.id,
    targetId: existing ? tab.targetId : 'target-1', selector: 'input[type=file]',
    filePath: path.join(first, 'artifact.txt'), instanceId: 'future', provider: 'claude', actionHint: 'Upload artifact' };
  const create = async (uploadRoots: string[], overrides: Partial<BrowserCreateGrantRequest> = {}) => {
    const result = await f.service.createGrant({
      mode: 'persistent', nodeId, ...(!existing ? { profileId: profile.id } : {}),
      instanceId: 'original', provider: 'codex', requestedBy: 'operator',
      allowedOrigins: profile.allowedOrigins, allowedActionClasses: ['file-upload'],
      allowExternalNavigation: false, autonomous: true, uploadRoots,
      expiresAt: Date.now() + 60_000, ...overrides,
    });
    expect(result.decision).toBe('allowed');
    return result.data!;
  };
  const rootless = () => create([], { mode: 'session', instanceId: request.instanceId,
    provider: 'claude', autonomous: false });
  return { ...f, db, store, root, first, second, profile, profileRoot, request, create, rootless, sendCommand };
}

afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe('persistent upload grant selection', () => {
  it.each(scenarios)('keeps two approved folders usable beyond 100 newer grants (existing=$existing, node=$nodeId)', async ({ existing, nodeId }) => {
    const f = fixture(existing, nodeId);
    const first = await f.create([f.first]);
    const second = await f.create([f.second]);
    f.db.prepare('UPDATE browser_permission_grants SET created_at = 1 WHERE id IN (?, ?)').run(first.id, second.id);
    for (let index = 0; index < 101; index++) await f.rootless();
    const page = f.store.listGrants({ instanceId: f.request.instanceId, nodeId });
    expect(page).toHaveLength(100);
    expect(page.some(({ id }) => id === first.id || id === second.id)).toBe(false);
    for (const [directory, grantId] of [[f.first, first.id], [f.second, second.id]]) {
      expect(await f.service.uploadFile({ ...f.request, filePath: path.join(directory, 'artifact.txt') }))
        .toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
      expect(f.audits.at(-1)?.grantId).toBe(grantId);
    }
    f.store.revokeGrant(first.id);
    expect(await f.service.uploadFile(f.request)).toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    expect(f.approvalRequests.at(-1)?.proposedGrant.uploadRoots).toContain(fs.realpathSync(f.first));
    expect(await f.service.uploadFile({ ...f.request, filePath: path.join(f.second, 'artifact.txt') }))
      .toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(f.audits.at(-1)?.grantId).toBe(second.id);
  });

  it.each(scenarios)('does not borrow folder consent from another computer or site (existing=$existing, node=$nodeId)', async ({ existing, nodeId }) => {
    const f = fixture(existing, nodeId);
    const currentNode = f.profile.executionNodeId;
    if (!existing) f.profile.executionNodeId = 'other-worker';
    const otherComputer = await f.create([f.first], { nodeId: 'other-worker' });
    expect(otherComputer.nodeId).toBe('other-worker');
    f.profile.executionNodeId = currentNode;
    await f.create([f.first], { allowedOrigins: [{ scheme: 'https', hostPattern: 'other.example', includeSubdomains: false }] });
    await f.rootless();
    expect(await f.service.uploadFile(f.request)).toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    expect(f.driver.uploadFile).not.toHaveBeenCalled();
    expect(f.sendCommand).not.toHaveBeenCalled();
  });

  it.each([false, true])('rechecks a replacement folder grant before upload (existing=%s)', async (existing) => {
    const f = fixture(existing);
    const standing = await f.create([f.first]);
    f.db.prepare('UPDATE browser_permission_grants SET created_at = 1 WHERE id = ?').run(standing.id);
    await f.rootless();
    let lookups = 0;
    Object.assign(f.grantStore, { listGrants: (filter: Parameters<BrowserGrantStore['listGrants']>[0]) => {
      if (++lookups === 3) f.store.revokeGrant(standing.id);
      return f.store.listGrants(filter);
    } });
    expect(await f.service.uploadFile(f.request)).toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    expect(lookups).toBe(3);
    expect(f.driver.uploadFile).not.toHaveBeenCalled();
    expect(f.sendCommand).not.toHaveBeenCalled();
  });

  it.each([false, true])('still blocks secret and hardlinked files under standing grants (existing=%s)', async (existing) => {
    const f = fixture(existing);
    await f.create([f.first]);
    await f.create([f.second]);
    await f.rootless();
    const secret = path.join(f.first, '.env');
    const hardlink = path.join(f.first, 'linked.txt');
    fs.writeFileSync(secret, 'placeholder');
    fs.linkSync(f.request.filePath, hardlink);
    for (const filePath of [secret, hardlink]) {
      expect(await f.service.uploadFile({ ...f.request, filePath }))
        .toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    }
    expect(f.driver.uploadFile).not.toHaveBeenCalled();
    expect(f.sendCommand).not.toHaveBeenCalled();
  });

  it('keeps managed profile files blocked but honours explicit consent for a userData sibling folder', async () => {
    const f = fixture(false);
    const exports = path.join(path.dirname(f.profileRoot), 'exports');
    fs.mkdirSync(exports);
    const filePath = path.join(exports, 'artifact.txt');
    fs.writeFileSync(filePath, 'test');
    const standing = await f.create([exports, f.profileRoot]);
    f.db.prepare('UPDATE browser_permission_grants SET created_at = 1 WHERE id = ?').run(standing.id);
    await f.rootless();
    expect(await f.service.uploadFile({ ...f.request, filePath: path.join(f.profileRoot, 'artifact.txt') }))
      .toMatchObject({ decision: 'requires_user', outcome: 'not_run', reason: expect.stringContaining('browser_profile_path_blocked') });
    expect(f.driver.uploadFile).not.toHaveBeenCalled();
    expect(await f.service.uploadFile({ ...f.request, filePath })).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(f.audits.at(-1)?.grantId).toBe(standing.id);
  });
});
