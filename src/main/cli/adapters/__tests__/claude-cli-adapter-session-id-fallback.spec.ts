/**
 * ClaudeCliAdapter — resume / session-id fallback (B7)
 *
 * Regression cover for a campaign-killing pair of defects found by livetest:
 * every loop iteration after the first died with `Claude CLI exited with code 1`
 * whenever the workspace path traversed a symlink.
 *
 *  1. The transcript probe encoded the *raw* cwd, but the CLI encodes the
 *     resolved one — so `/tmp/ws` (→ `/private/tmp/ws` on macOS) never matched
 *     its own transcript and `--resume` was skipped.
 *  2. The skip-path then reused the same id via `--session-id`, which the CLI
 *     rejects outright ("Session ID … is already in use.") — a guaranteed exit 1.
 *
 * These use a real temp HOME and a real symlink so the encoding is exercised
 * rather than modelled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  getLogManager: () => ({
    getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test', isPackaged: false },
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({ store: {}, get: vi.fn(), set: vi.fn() })),
}));

const homeFixture = vi.hoisted(() => ({ home: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => homeFixture.home || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const { ClaudeCliAdapter } = await import('../claude-cli-adapter');

const SESSION_ID = '0dca9e50-8fef-4268-86bf-9a6306f2fbea';

/** Mirrors the CLI's lossy project-dir encoding. */
function projectDir(home: string, cwd: string): string {
  return join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

function writeTranscript(home: string, cwd: string, sessionId: string): void {
  const dir = projectDir(home, cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
}

/** `buildArgs` is protected; the argv it returns is exactly what gets spawned. */
function captureArgs(adapter: InstanceType<typeof ClaudeCliAdapter>): string[] {
  const build = (adapter as unknown as { buildArgs: (m: unknown) => string[] }).buildArgs;
  return build.call(adapter, { role: 'user', content: 'iteration 2' });
}

describe('ClaudeCliAdapter — resume/session-id fallback', () => {
  let home: string;
  let realCwd: string;
  let linkedCwd: string;

  beforeEach(() => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), 'aio-b7-'));
    home = join(base, 'home');
    realCwd = join(base, 'real-workspace');
    linkedCwd = join(base, 'linked-workspace');
    mkdirSync(home, { recursive: true });
    mkdirSync(realCwd, { recursive: true });
    symlinkSync(realCwd, linkedCwd);
    homeFixture.home = home;
  });

  afterEach(() => {
    homeFixture.home = '';
    rmSync(join(realCwd, '..'), { recursive: true, force: true });
  });

  it('resumes when the transcript sits under the resolved cwd, not the given one', () => {
    // What the CLI actually did: wrote the transcript under the real path.
    writeTranscript(home, realCwd, SESSION_ID);

    const adapter = new ClaudeCliAdapter({
      sessionId: SESSION_ID,
      workingDirectory: linkedCwd,
      resume: true,
    });
    const args = captureArgs(adapter);

    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(SESSION_ID);
    expect(args).not.toContain('--session-id');
  });

  it('omits --session-id when the id is in use by a transcript it cannot resume', () => {
    // Transcript exists, but under an unrelated project dir — unreachable from
    // this cwd, yet enough for the CLI to reject the id.
    writeTranscript(home, join(realCwd, '..', 'somewhere-else'), SESSION_ID);

    const adapter = new ClaudeCliAdapter({
      sessionId: SESSION_ID,
      workingDirectory: linkedCwd,
      resume: true,
    });
    const args = captureArgs(adapter);

    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--session-id');
  });

  it('still pins --session-id for an id the CLI has never minted', () => {
    const adapter = new ClaudeCliAdapter({
      sessionId: SESSION_ID,
      workingDirectory: linkedCwd,
      resume: true,
    });
    const args = captureArgs(adapter);

    expect(args).not.toContain('--resume');
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe(SESSION_ID);
  });
});
