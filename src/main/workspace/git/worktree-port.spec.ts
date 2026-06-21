/**
 * P7 acceptance: each isolated session gets its own renderer port at acquire
 * time, written into a per-worktree `.mise.local.toml`, so two renderer/smoke
 * sessions never collide on the shared AIO_RENDERER_PORT (4567).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import {
  allocateRendererPort,
  assignWorktreeRendererPort,
  isPortFree,
  renderMiseLocalOverride,
  DEFAULT_RENDERER_PORT,
} from './worktree-port';

// Binds real loopback ports per test — generous timeout for loaded CI/commit runs.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'wt-port-'));
});

afterEach(() => {
  try {
    rmSync(worktree, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe('allocateRendererPort', () => {
  it('returns a free port at/above the base', async () => {
    const port = await allocateRendererPort({ base: 14567, span: 50 });
    expect(port).toBeGreaterThanOrEqual(14567);
    await expect(isPortFree(port)).resolves.toBe(true);
  });

  it('skips ports already reserved by sibling sessions', async () => {
    const exclude = new Set([14600, 14601]);
    const port = await allocateRendererPort({ base: 14600, span: 50, exclude });
    expect(port).toBeGreaterThanOrEqual(14602);
    expect(exclude.has(port)).toBe(false);
  });

  it('skips a port that is actually in use', async () => {
    // Occupy a port, then assert the allocator steps over it.
    const server = net.createServer();
    const base = 14700;
    await new Promise<void>((resolve) => server.listen(base, '127.0.0.1', resolve));
    try {
      const port = await allocateRendererPort({ base, span: 50 });
      expect(port).toBeGreaterThan(base);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('throws when no port is free in the window', async () => {
    // Exclude the entire 1-slot window.
    await expect(
      allocateRendererPort({ base: 14800, span: 1, exclude: new Set([14800]) }),
    ).rejects.toThrow(/No free renderer port/);
  });
});

describe('renderMiseLocalOverride', () => {
  it('emits a [env] block setting AIO_RENDERER_PORT', () => {
    const body = renderMiseLocalOverride(4599);
    expect(body).toContain('[env]');
    expect(body).toContain('AIO_RENDERER_PORT = "4599"');
  });
});

describe('assignWorktreeRendererPort', () => {
  it('allocates a port and writes .mise.local.toml into the worktree', async () => {
    const port = await assignWorktreeRendererPort(worktree, { base: 14900, span: 50 });
    expect(port).toBeGreaterThanOrEqual(14900);
    const content = readFileSync(join(worktree, '.mise.local.toml'), 'utf-8');
    expect(content).toContain(`AIO_RENDERER_PORT = "${port}"`);
  });

  it('two sessions excluding each other get distinct ports', async () => {
    const reserved = new Set<number>();
    const w2 = mkdtempSync(join(tmpdir(), 'wt-port2-'));
    try {
      const p1 = await assignWorktreeRendererPort(worktree, { base: 15000, span: 50, exclude: reserved });
      reserved.add(p1);
      const p2 = await assignWorktreeRendererPort(w2, { base: 15000, span: 50, exclude: reserved });
      expect(p2).not.toBe(p1);
    } finally {
      rmSync(w2, { recursive: true, force: true });
    }
  });

  it('default base matches the shared .mise.toml port', () => {
    expect(DEFAULT_RENDERER_PORT).toBe(4567);
  });
});
