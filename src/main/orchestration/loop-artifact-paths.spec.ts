import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  resolveLoopArtifactPaths,
  loopStateFile,
  loopStateRelFile,
  LOOP_STATE_DIR_NAME,
} from './loop-artifact-paths';

describe('resolveLoopArtifactPaths', () => {
  it('scopes every state file under <workspace>/.aio-loop-state/<runId>/', () => {
    const ws = '/tmp/ws';
    const p = resolveLoopArtifactPaths(ws, 'loop-123-abcd');
    const dir = path.join(ws, LOOP_STATE_DIR_NAME, 'loop-123-abcd');
    expect(p.dir).toBe(dir);
    expect(p.stage).toBe(path.join(dir, 'STAGE.md'));
    expect(p.notes).toBe(path.join(dir, 'NOTES.md'));
    expect(p.iterationLog).toBe(path.join(dir, 'ITERATION_LOG.md'));
    expect(p.tasks).toBe(path.join(dir, 'LOOP_TASKS.md'));
    expect(p.tasksArchive).toBe(path.join(dir, 'LOOP_TASKS.prev.md'));
    expect(p.blocked).toBe(path.join(dir, 'BLOCKED.md'));
  });

  it('exposes a workspace-relative POSIX relDir for prompt injection', () => {
    const p = resolveLoopArtifactPaths('/tmp/ws', 'loop-x');
    expect(p.relDir).toBe(`${LOOP_STATE_DIR_NAME}/loop-x`);
  });

  it('is deterministic — same inputs re-derive the identical dir (recovery)', () => {
    const a = resolveLoopArtifactPaths('/tmp/ws', 'loop-x');
    const b = resolveLoopArtifactPaths('/tmp/ws', 'loop-x');
    expect(a).toEqual(b);
  });

  it('isolates distinct run ids in the same workspace', () => {
    const a = resolveLoopArtifactPaths('/tmp/ws', 'loop-A');
    const b = resolveLoopArtifactPaths('/tmp/ws', 'loop-B');
    expect(a.dir).not.toBe(b.dir);
    expect(a.stage).not.toBe(b.stage);
  });

  it('resolves a relative workspace to an absolute state dir', () => {
    const p = resolveLoopArtifactPaths('relative/ws', 'loop-x');
    expect(path.isAbsolute(p.dir)).toBe(true);
  });

  it('loopStateFile / loopStateRelFile join a configurable name onto the dir', () => {
    const p = resolveLoopArtifactPaths('/tmp/ws', 'loop-x');
    expect(loopStateFile(p, 'DONE.txt')).toBe(path.join(p.dir, 'DONE.txt'));
    expect(loopStateRelFile(p, 'DONE.txt')).toBe(`${p.relDir}/DONE.txt`);
  });
});
