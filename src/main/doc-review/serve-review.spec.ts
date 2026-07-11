import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Integration test for the portable capture server (serve-review.mjs): it serves the
 * artifact with a capture token injected, accepts a token-gated POST of decisions (writing
 * the JSON beside the artifact and printing the canonical block), and rejects a bad token.
 */

const SERVER = join(
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
  child: ChildProcessWithoutNullStreams;
  url: string;
  stdout: () => string;
}

function startServer(artifactPath: string): Promise<Started> {
  const child = spawn('node', [SERVER, artifactPath], { stdio: ['ignore', 'pipe', 'pipe'] });
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

describe('serve-review.mjs capture server', () => {
  let tempRoot = '';
  let running: ChildProcessWithoutNullStreams | null = null;

  afterEach(() => {
    running?.kill('SIGTERM');
    running = null;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('serves the artifact with a capture token and captures a token-gated submission', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'serve-review-'));
    const artifactPath = join(tempRoot, 'plan.html');
    writeFileSync(artifactPath, ARTIFACT_HTML);

    const started = await startServer(artifactPath);
    running = started.child;

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
      items: [{ id: 'a', title: 'Phase 1', decision: 'reject', comment: 'redo\nthis' }],
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
    expect(out).toContain('1. [Phase 1] reject — redo this');
    expect(out).toContain('AIO_REVIEW_CAPTURED');
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
