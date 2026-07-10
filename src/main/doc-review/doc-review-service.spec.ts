import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for DocReviewService: session lifecycle, artifact-path security (inside
 * .aio-review/, symlink-escape rejection), feedback-block rendering, and prune logic.
 * electron-store is mocked to an in-memory map so no real userData is touched.
 */

const ARTIFACT_HTML =
  '<!DOCTYPE html><html><head><meta name="aio-doc-review" content="v1">' +
  '<meta name="aio-doc-review-title" content="Test Plan"></head><body>x</body></html>';

let tempRoot = '';
let workspace = '';
let reviewDir = '';

async function loadService() {
  const mod = await import('./doc-review-service');
  mod.DocReviewService._resetForTesting();
  return mod;
}

describe('DocReviewService', () => {
  beforeEach(() => {
    vi.resetModules();
    tempRoot = mkdtempSync(join(tmpdir(), 'doc-review-'));
    workspace = join(tempRoot, 'workspace');
    reviewDir = join(workspace, '.aio-review');
    mkdirSync(reviewDir, { recursive: true });

    vi.doMock('electron', () => ({
      app: { getPath: vi.fn(() => tempRoot) },
    }));
    vi.doMock('electron-store', () => ({
      default: class MockStore<T extends Record<string, unknown>> {
        private data: Record<string, unknown>;
        constructor(options?: { defaults?: T }) {
          this.data = structuredClone(options?.defaults ?? {});
        }
        get<K extends keyof T>(key: K): T[K] {
          return this.data[key as string] as T[K];
        }
        set(keyOrObj: unknown, value?: unknown): void {
          if (typeof keyOrObj === 'string') this.data[keyOrObj] = value;
          else Object.assign(this.data, keyOrObj);
        }
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock('electron');
    vi.doUnmock('electron-store');
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeArtifact(name = 'plan.html'): string {
    const p = join(reviewDir, name);
    writeFileSync(p, ARTIFACT_HTML);
    return p;
  }

  it('creates a pending session for a valid artifact inside .aio-review/', async () => {
    const { getDocReviewService } = await loadService();
    const service = getDocReviewService();
    const artifactPath = writeArtifact();

    const session = await service.createSession({
      instanceId: 'inst-1',
      workspacePath: workspace,
      title: 'Test Plan',
      artifactPath,
    });

    expect(session.status).toBe('pending');
    expect(session.instanceId).toBe('inst-1');
    expect(service.listSessions('pending')).toHaveLength(1);
  });

  it('rejects an artifact path outside .aio-review/', async () => {
    const { getDocReviewService } = await loadService();
    const service = getDocReviewService();
    const outside = join(workspace, 'plan.html');
    writeFileSync(outside, ARTIFACT_HTML);

    await expect(
      service.createSession({
        instanceId: 'inst-1',
        workspacePath: workspace,
        title: 'Test Plan',
        artifactPath: outside,
      }),
    ).rejects.toThrow(/\.aio-review/);
  });

  it('rejects a symlink that escapes .aio-review/', async () => {
    const { getDocReviewService } = await loadService();
    const service = getDocReviewService();
    const outside = join(tempRoot, 'evil.html');
    writeFileSync(outside, ARTIFACT_HTML);
    const link = join(reviewDir, 'link.html');
    symlinkSync(outside, link);

    await expect(
      service.createSession({
        instanceId: 'inst-1',
        workspacePath: workspace,
        title: 'Test Plan',
        artifactPath: link,
      }),
    ).rejects.toThrow(/\.aio-review/);
  });

  it('rejects a file that is not a doc-review artifact', async () => {
    const { getDocReviewService } = await loadService();
    const service = getDocReviewService();
    const notArtifact = join(reviewDir, 'notes.html');
    writeFileSync(notArtifact, '<html><body>just notes</body></html>');

    await expect(
      service.createSession({
        instanceId: 'inst-1',
        workspacePath: workspace,
        title: 'X',
        artifactPath: notArtifact,
      }),
    ).rejects.toThrow(/not a doc-review artifact/);
  });

  it('pushes the canonical feedback block and marks the session decided', async () => {
    const { getDocReviewService } = await loadService();
    const service = getDocReviewService();
    const sent: { id: string; message: string }[] = [];
    service.setInstanceManager({
      sendInput: async (id, message) => {
        sent.push({ id, message });
      },
    });
    const session = await service.createSession({
      instanceId: 'inst-1',
      workspacePath: workspace,
      title: 'Test Plan',
      artifactPath: writeArtifact(),
    });

    const decided = await service.submitDecision(session.id, {
      overall: 'changes_requested',
      decisions: [
        { itemId: 'a', title: 'Overview', decisionId: null, decision: 'approve' },
        { itemId: 'b', title: 'Phase 2', decisionId: '1', decision: 'reject', comment: 'too big' },
      ],
      generalComment: 'nearly there',
    });

    expect(decided.status).toBe('changes_requested');
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe('inst-1');
    expect(sent[0].message).toContain('## Document review feedback — Test Plan');
    expect(sent[0].message).toContain('Overall: CHANGES REQUESTED');
    expect(sent[0].message).toContain('1. [Overview] approve');
    expect(sent[0].message).toContain('2. [Phase 2] reject — too big');
    expect(sent[0].message).toContain('General: nearly there');
  });

  it('refuses to decide a session twice', async () => {
    const { getDocReviewService } = await loadService();
    const service = getDocReviewService();
    service.setInstanceManager({ sendInput: async () => undefined });
    const session = await service.createSession({
      instanceId: 'inst-1',
      workspacePath: workspace,
      title: 'Test Plan',
      artifactPath: writeArtifact(),
    });
    await service.submitDecision(session.id, { overall: 'approved', decisions: [] });
    await expect(
      service.submitDecision(session.id, { overall: 'approved', decisions: [] }),
    ).rejects.toThrow(/already decided/);
  });

  it('prunes decided sessions older than 30 days but keeps pending', async () => {
    const { getDocReviewService } = await loadService();
    const service = getDocReviewService();
    service.setInstanceManager({ sendInput: async () => undefined });
    const stale = await service.createSession({
      instanceId: 'inst-1',
      workspacePath: workspace,
      title: 'Stale',
      artifactPath: writeArtifact('stale.html'),
    });
    await service.submitDecision(stale.id, { overall: 'approved', decisions: [] });
    await service.createSession({
      instanceId: 'inst-2',
      workspacePath: workspace,
      title: 'Fresh Pending',
      artifactPath: writeArtifact('fresh.html'),
    });

    const future = Date.now() + 31 * 24 * 60 * 60 * 1000;
    service.pruneDecided(future);

    const all = service.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('pending');
  });

  it('renders a plan markdown file into an artifact and creates a pending review', async () => {
    const { getDocReviewService } = await loadService();
    const service = getDocReviewService();
    const planPath = join(workspace, 'PLAN.md');
    writeFileSync(planPath, '# The Plan\n\nIntro.\n\n## Phase 1\n\nDo it.\n');

    const session = await service.createReviewFromPlan({
      instanceId: 'chat-1',
      workspacePath: workspace,
      planFile: 'PLAN.md',
      generatedAt: '2026-07-10',
    });

    expect(session.status).toBe('pending');
    expect(session.title).toBe('The Plan');
    expect(session.sourcePath).toBe('PLAN.md');
    expect(session.artifactPath).toContain('.aio-review');
    // The rendered artifact is a valid v1 artifact reachable through readArtifact.
    await expect(service.readArtifact(session.id)).resolves.toContain('aio-doc-review');
  });

  it('invokes the approval recorder only when a review is approved', async () => {
    const { getDocReviewService } = await loadService();
    const service = getDocReviewService();
    service.setInstanceManager({ sendInput: async () => undefined });
    const recorded: string[] = [];
    service.setApprovalRecorder((s) => recorded.push(s.id));

    const rejectedSession = await service.createSession({
      instanceId: 'inst-1',
      workspacePath: workspace,
      title: 'R',
      artifactPath: writeArtifact('r.html'),
    });
    await service.submitDecision(rejectedSession.id, { overall: 'rejected', decisions: [] });
    expect(recorded).toHaveLength(0);

    const approvedSession = await service.createSession({
      instanceId: 'inst-1',
      workspacePath: workspace,
      title: 'A',
      artifactPath: writeArtifact('a.html'),
    });
    await service.submitDecision(approvedSession.id, { overall: 'approved', decisions: [] });
    expect(recorded).toEqual([approvedSession.id]);
  });

  it('dismiss removes a pending session', async () => {
    const { getDocReviewService } = await loadService();
    const service = getDocReviewService();
    const session = await service.createSession({
      instanceId: 'inst-1',
      workspacePath: workspace,
      title: 'Test Plan',
      artifactPath: writeArtifact(),
    });
    service.dismiss(session.id);
    expect(service.listSessions()).toHaveLength(0);
  });
});
