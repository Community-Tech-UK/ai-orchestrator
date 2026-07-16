/**
 * Tests for last-stop-snapshot.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  LastStopSnapshotManager,
  initLastStopSnapshot,
  getLastStopSnapshotIfInitialized,
  _resetLastStopSnapshotForTesting,
  type RecoverableSession,
} from '../last-stop-snapshot';

const TEST_DIR = path.join(os.tmpdir(), `last-stop-snapshot-test-${process.pid}`);

function makeSession(overrides: Partial<RecoverableSession> = {}): RecoverableSession {
  return {
    instanceId: 'inst-1',
    sessionId: 'sess-abc',
    displayName: 'Test session',
    workingDirectory: '/home/user/project',
    capturedAt: Date.now(),
    provider: 'claude',
    modelId: 'claude-sonnet-4-6',
    ...overrides,
  };
}

beforeEach(() => {
  _resetLastStopSnapshotForTesting();
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  _resetLastStopSnapshotForTesting();
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── saveSnapshot / getSnapshot round-trip ─────────────────────────────────────

describe('LastStopSnapshotManager — round-trip', () => {
  it('saves and retrieves a single recoverable session', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    const session = makeSession();
    mgr.saveSnapshot([session]);

    const snap = mgr.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.sessions).toHaveLength(1);
    expect(snap!.sessions[0].instanceId).toBe('inst-1');
    expect(snap!.sessions[0].sessionId).toBe('sess-abc');
  });

  it('saves multiple sessions and retrieves all of them', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    const sessions = [
      makeSession({ instanceId: 'a', sessionId: 'sa' }),
      makeSession({ instanceId: 'b', sessionId: 'sb' }),
      makeSession({ instanceId: 'c', sessionId: 'sc' }),
    ];
    mgr.saveSnapshot(sessions);

    const snap = mgr.getSnapshot();
    expect(snap!.sessions).toHaveLength(3);
    expect(snap!.sessions.map((s) => s.instanceId)).toEqual(['a', 'b', 'c']);
  });

  it('also persists sessions that only have a resumeCursor (no sessionId)', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    const session = makeSession({
      sessionId: undefined,
      resumeCursor: {
        provider: 'claude',
        threadId: 'thread-xyz',
        workspacePath: '/home/user/project',
        capturedAt: Date.now(),
        scanSource: 'native',
      },
    });
    mgr.saveSnapshot([session]);

    const snap = mgr.getSnapshot();
    expect(snap!.sessions).toHaveLength(1);
    expect(snap!.sessions[0].resumeCursor?.threadId).toBe('thread-xyz');
  });
});

// ── Filtering: stateless providers ───────────────────────────────────────────

describe('LastStopSnapshotManager — stateless provider filtering', () => {
  it('excludes gemini sessions (stateless, no native resume)', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    mgr.saveSnapshot([
      makeSession({ provider: 'gemini', sessionId: 'should-be-excluded' }),
    ]);
    // Should have cleared any old file and returned null
    const snap = mgr.getSnapshot();
    expect(snap).toBeNull();
  });

  it('includes claude, codex, copilot, cursor sessions', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    mgr.saveSnapshot([
      makeSession({ instanceId: 'c1', provider: 'claude', sessionId: 's1' }),
      makeSession({ instanceId: 'c2', provider: 'codex', sessionId: 's2' }),
      makeSession({ instanceId: 'c3', provider: 'copilot', sessionId: 's3' }),
      makeSession({ instanceId: 'c4', provider: 'cursor', sessionId: 's4' }),
    ]);
    const snap = mgr.getSnapshot();
    expect(snap!.sessions).toHaveLength(4);
  });

  it('excludes sessions with no sessionId and no resumeCursor', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    mgr.saveSnapshot([
      makeSession({ sessionId: undefined, resumeCursor: null }),
      makeSession({ instanceId: 'b', sessionId: 'valid' }),
    ]);
    const snap = mgr.getSnapshot();
    expect(snap!.sessions).toHaveLength(1);
    expect(snap!.sessions[0].instanceId).toBe('b');
  });
});

// ── Atomicity: file-not-exist path ───────────────────────────────────────────

describe('LastStopSnapshotManager — getSnapshot', () => {
  it('returns null when the file does not exist', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    expect(mgr.getSnapshot()).toBeNull();
  });

  it('returns null when the file is corrupted JSON', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    fs.writeFileSync(path.join(TEST_DIR, 'last-stop.json'), 'not-valid-json', 'utf-8');
    expect(mgr.getSnapshot()).toBeNull();
  });

  it('returns null when the file has invalid structure', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    fs.writeFileSync(
      path.join(TEST_DIR, 'last-stop.json'),
      JSON.stringify({ wrong: true }),
      'utf-8',
    );
    expect(mgr.getSnapshot()).toBeNull();
  });

  it('returns null when snapshot is older than 7 days', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    const staleSnap = {
      writtenAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      sessions: [makeSession()],
    };
    fs.writeFileSync(
      path.join(TEST_DIR, 'last-stop.json'),
      JSON.stringify(staleSnap),
      'utf-8',
    );
    expect(mgr.getSnapshot()).toBeNull();
  });

  it('prunes per-session entries older than 7 days but keeps the rest', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    const snap = {
      writtenAt: Date.now(),
      sessions: [
        makeSession({ instanceId: 'fresh', capturedAt: Date.now() }),
        makeSession({ instanceId: 'stale', capturedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
      ],
    };
    fs.writeFileSync(path.join(TEST_DIR, 'last-stop.json'), JSON.stringify(snap), 'utf-8');
    const result = mgr.getSnapshot();
    expect(result!.sessions).toHaveLength(1);
    expect(result!.sessions[0].instanceId).toBe('fresh');
  });
});

// ── clear() ──────────────────────────────────────────────────────────────────

describe('LastStopSnapshotManager — clear()', () => {
  it('removes the snapshot file', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    mgr.saveSnapshot([makeSession()]);
    expect(mgr.getSnapshot()).not.toBeNull();

    mgr.clear();
    expect(mgr.getSnapshot()).toBeNull();
  });

  it('does not throw when called with no snapshot on disk', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    expect(() => mgr.clear()).not.toThrow();
  });
});

// ── saveSnapshot — empty result clears existing file ─────────────────────────

describe('LastStopSnapshotManager — empty snapshot clears stale file', () => {
  it('removes old snapshot when no sessions are recoverable', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    mgr.saveSnapshot([makeSession()]);
    expect(mgr.getSnapshot()).not.toBeNull();

    // Now write only gemini sessions (filtered out → empty)
    mgr.saveSnapshot([makeSession({ provider: 'gemini' })]);
    expect(mgr.getSnapshot()).toBeNull();
  });
});

// ── Capacity cap ─────────────────────────────────────────────────────────────

describe('LastStopSnapshotManager — capacity cap', () => {
  it('caps snapshot at 20 sessions', () => {
    const mgr = new LastStopSnapshotManager(TEST_DIR);
    const sessions = Array.from({ length: 25 }, (_, i) =>
      makeSession({ instanceId: `inst-${i}`, sessionId: `sess-${i}` }),
    );
    mgr.saveSnapshot(sessions);
    const snap = mgr.getSnapshot();
    expect(snap!.sessions).toHaveLength(20);
  });
});

// ── Module-level singleton ────────────────────────────────────────────────────

describe('module-level helpers', () => {
  it('getLastStopSnapshotIfInitialized returns null before init', () => {
    expect(getLastStopSnapshotIfInitialized()).toBeNull();
  });

  it('initLastStopSnapshot wires the singleton', () => {
    const mgr = initLastStopSnapshot(TEST_DIR);
    expect(mgr).toBeInstanceOf(LastStopSnapshotManager);
    expect(getLastStopSnapshotIfInitialized()).toBe(mgr);
  });

  it('_resetLastStopSnapshotForTesting clears the singleton', () => {
    initLastStopSnapshot(TEST_DIR);
    _resetLastStopSnapshotForTesting();
    expect(getLastStopSnapshotIfInitialized()).toBeNull();
  });
});
