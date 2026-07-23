import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

// All spawn() calls in this file use stdio: ['ignore', 'pipe', 'pipe'], so
// the process has no stdin stream (null) and piped stdout/stderr.
type ServerChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Integration test for the portable capture server (serve-review.mjs): it serves the
 * artifact with a capture token injected, accepts a token-gated POST of decisions (writing
 * the JSON beside the artifact and printing the canonical block), and rejects a bad token.
 */

const SERVER = join(
  __dirname,
  'assets',
  'serve-review.mjs',
);
const PORTABLE_SERVER = join(
  process.cwd(),
  '.claude',
  'skills',
  'doc-review-artifact',
  'references',
  'serve-review.mjs',
);

const ARTIFACT_HTML =
  '<!DOCTYPE html><html><head><meta name="aio-doc-review" content="v1">' +
  '<meta name="aio-doc-review-title" content="Test Plan"></head><body>x</body></html>';

interface Started {
  child: ServerChild;
  url: string;
  stdout: () => string;
}

function startServer(artifactPath: string, args: string[] = []): Promise<Started> {
  const child = spawn('node', [SERVER, artifactPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  child.stderr.on('data', () => { /* diagnostics only */ });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not report a URL in time')), 8000);
    child.stdout.on('data', () => {
      const match = /AIO_REVIEW_URL (\S+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: match[1], stdout: () => out });
      }
    });
    child.on('error', reject);
  });
}

async function waitForFiles(paths: string[], timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const missing = paths.filter((path) => !existsSync(path));
  throw new Error(`Timed out waiting for files: ${missing.join(', ')}`);
}

describe('serve-review.mjs capture server', () => {
  let tempRoot = '';
  let running: ServerChild | null = null;

  afterEach(() => {
    running?.kill('SIGTERM');
    running = null;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  // The portable copy lives under the gitignored, externally-authored
  // .claude/skills/ dir and is absent on fresh clones / machines without the
  // skill installed. Only assert parity when that copy is actually present.
  it.skipIf(!existsSync(PORTABLE_SERVER))('keeps the portable capture server synchronized with the in-app asset', () => {
    expect(readFileSync(PORTABLE_SERVER, 'utf8')).toBe(readFileSync(SERVER, 'utf8'));
  });

  it('captures durably, responds, and exits to wake the launching agent', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'serve-review-'));
    const artifactPath = join(tempRoot, 'plan.html');
    writeFileSync(artifactPath, ARTIFACT_HTML);

    const started = await startServer(artifactPath);
    running = started.child;
    const exited = new Promise<number | null>((resolve) => started.child.once('exit', resolve));

    // The served page carries the injected capture meta.
    const page = await fetch(started.url);
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    const token = /name="aio-doc-review-capture" content="([^"]+)"/.exec(pageHtml)?.[1];
    expect(token).toBeTruthy();

    // A POST with a bad token is rejected.
    const bad = await fetch(new URL('/decisions', started.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aio-review-token': 'wrong' },
      body: JSON.stringify({ items: [] }),
    });
    expect(bad.status).toBe(401);

    // A POST with the real token captures: writes the JSON + prints the canonical block.
    const decisions = {
      reviewId: '2026-07-11-test',
      title: 'Test Plan',
      overall: 'changes_requested',
      general: 'close',
      items: [{
        id: 'a',
        title: 'Phase 1',
        decision: 'reject',
        choice: 'b',
        choices: [],
        comment: 'redo\nthis',
      }],
    };
    const ok = await fetch(new URL('/decisions', started.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aio-review-token': token! },
      body: JSON.stringify(decisions),
    });
    expect(ok.status).toBe(200);

    const decisionsPath = join(tempRoot, 'plan.decisions.json');
    expect(existsSync(decisionsPath)).toBe(true);
    const written = JSON.parse(readFileSync(decisionsPath, 'utf8'));
    expect(written.overall).toBe('changes_requested');

    // Give stdout a beat to flush the printed block.
    await new Promise((r) => setTimeout(r, 100));
    const out = started.stdout();
    expect(out).toContain('## Document review feedback — Test Plan');
    expect(out).toContain('1. [Phase 1] reject — choice: b — redo this');
    expect(out).toContain('AIO_REVIEW_CAPTURED');
    expect(await exited).toBe(0);
    running = null;
  });

  it('keeps serving after capture when --stay-alive is requested', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'serve-review-'));
    const artifactPath = join(tempRoot, 'plan.html');
    writeFileSync(artifactPath, ARTIFACT_HTML);
    const started = await startServer(artifactPath, ['--stay-alive']);
    running = started.child;
    const pageHtml = await (await fetch(started.url)).text();
    const token = /name="aio-doc-review-capture" content="([^"]+)"/.exec(pageHtml)?.[1];

    const response = await fetch(new URL('/decisions', started.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aio-review-token': token! },
      body: JSON.stringify({ items: [] }),
    });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started.child.exitCode).toBeNull();
  });

  // The hook is an extension-less shebang script chmod'd 0o755 — a POSIX
  // executable mechanism Windows CreateProcess cannot run (and chmod is a no-op).
  it.skipIf(process.platform === 'win32')('runs an on-capture executable with the durable decisions path', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'serve-review-'));
    const artifactPath = join(tempRoot, 'plan.html');
    const capturedPath = join(tempRoot, 'hook-path.txt');
    const capturedEnvironmentPath = join(tempRoot, 'hook-environment.txt');
    const hookPath = join(tempRoot, 'capture-hook');
    writeFileSync(artifactPath, ARTIFACT_HTML);
    writeFileSync(
      hookPath,
      `#!${process.execPath}\n` +
        `const { writeFileSync } = require('node:fs');\n` +
        `setTimeout(() => {\n` +
        `  writeFileSync(${JSON.stringify(capturedPath)}, process.argv[2]);\n` +
        `  writeFileSync(${JSON.stringify(capturedEnvironmentPath)}, process.env.PATH ?? 'unset');\n` +
        `}, 650);\n`,
      { mode: 0o755 },
    );
    const started = await startServer(artifactPath, ['--on-capture', hookPath]);
    running = started.child;
    const pageHtml = await (await fetch(started.url)).text();
    const token = /name="aio-doc-review-capture" content="([^"]+)"/.exec(pageHtml)?.[1];

    const response = await fetch(new URL('/decisions', started.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aio-review-token': token! },
      body: JSON.stringify({ items: [] }),
    });

    expect(response.status).toBe(200);
    await waitForFiles([capturedPath, capturedEnvironmentPath]);
    expect(readFileSync(capturedPath, 'utf8')).toBe(join(tempRoot, 'plan.decisions.json'));
    expect(readFileSync(capturedEnvironmentPath, 'utf8')).toBe('unset');
  });

  it('rejects a non-absolute on-capture executable before serving', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'serve-review-'));
    const artifactPath = join(tempRoot, 'plan.html');
    writeFileSync(artifactPath, ARTIFACT_HTML);
    const child = spawn('node', [SERVER, artifactPath, '--on-capture', 'relative-hook'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

    // Safety net only: the server rejects the relative --on-capture path and
    // exits ~immediately, so this race resolves as soon as the child exits.
    // The timeout must be generous enough to survive a loaded host (cold
    // `node` start + module load can exceed a few hundred ms under CPU
    // pressure) — otherwise this flakes with `exitCode === null` in the full
    // suite while passing in isolation. A genuinely-hung process still fails
    // here after the net.
    const exitCode = await Promise.race([
      new Promise<number | null>((resolve) => child.once('exit', resolve)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain('--on-capture requires an absolute executable path');
    running = null;
  });

  it('does not let a long-running capture hook delay the response or wake exit', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'serve-review-'));
    const artifactPath = join(tempRoot, 'plan.html');
    const hookPath = join(tempRoot, 'slow-capture-hook');
    writeFileSync(artifactPath, ARTIFACT_HTML);
    writeFileSync(hookPath, '#!/bin/sh\n/bin/sleep 2\n', { mode: 0o755 });
    const started = await startServer(artifactPath, ['--on-capture', hookPath]);
    running = started.child;
    const pageHtml = await (await fetch(started.url)).text();
    const token = /name="aio-doc-review-capture" content="([^"]+)"/.exec(pageHtml)?.[1];
    const exited = new Promise<number | null>((resolve) => started.child.once('exit', resolve));
    const captureStartedAt = Date.now();

    const response = await fetch(new URL('/decisions', started.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aio-review-token': token! },
      body: JSON.stringify({ items: [] }),
    });

    expect(response.status).toBe(200);
    expect(await exited).toBe(0);
    expect(Date.now() - captureStartedAt).toBeLessThan(1_500);
    running = null;
  });

  it('rejects a non-JSON body', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'serve-review-'));
    const artifactPath = join(tempRoot, 'plan.html');
    writeFileSync(artifactPath, ARTIFACT_HTML);
    const started = await startServer(artifactPath);
    running = started.child;
    const pageHtml = await (await fetch(started.url)).text();
    const token = /name="aio-doc-review-capture" content="([^"]+)"/.exec(pageHtml)?.[1];

    const res = await fetch(new URL('/decisions', started.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aio-review-token': token! },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});
