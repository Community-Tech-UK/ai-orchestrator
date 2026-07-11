#!/usr/bin/env node
/**
 * serve-review.mjs — local, single-machine capture server for a doc-review artifact.
 *
 * Instead of downloading a `.decisions.json` into Downloads, the agent serves the artifact
 * over loopback and James clicks Submit; his decisions POST straight back here. Nothing is
 * downloaded, nothing is lost.
 *
 * Usage:  node serve-review.mjs <artifact.html> [--timeout-min 30]
 *
 * Contract with the caller (the doc-review-artifact skill), all on stdout:
 *   AIO_REVIEW_URL http://127.0.0.1:<port>/      (open this in a browser)
 *   ...on capture:
 *   <canonical "## Document review feedback" markdown block>
 *   AIO_REVIEW_CAPTURED <path to the written .decisions.json>
 *
 * Security posture: binds 127.0.0.1 only, rejects non-loopback peers, requires a random
 * per-run token on POST, caps the body, and auto-shuts down after the timeout. It only ever
 * serves the one artifact string in memory (no filesystem routes) and writes exactly one
 * file (the decisions JSON beside the artifact).
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const artifactArg = args.find((a) => !a.startsWith('--'));
if (!artifactArg) {
  process.stderr.write('usage: node serve-review.mjs <artifact.html> [--timeout-min 30]\n');
  process.exit(2);
}
const timeoutMinIdx = args.indexOf('--timeout-min');
const timeoutMin = timeoutMinIdx >= 0 ? Number(args[timeoutMinIdx + 1]) : 30;
const TIMEOUT_MS = Number.isFinite(timeoutMin) && timeoutMin > 0 ? timeoutMin * 60_000 : 30 * 60_000;
const MAX_BODY = 1024 * 1024; // 1 MB

const artifactPath = resolve(artifactArg);
const decisionsPath = join(
  dirname(artifactPath),
  basename(artifactPath).replace(/\.html?$/i, '') + '.decisions.json',
);
const token = randomUUID();

let artifactHtml;
try {
  artifactHtml = await readFile(artifactPath, 'utf8');
} catch (err) {
  process.stderr.write(`Cannot read artifact: ${String(err)}\n`);
  process.exit(2);
}

// Inject the capture token so the artifact's standalone runtime knows to POST back here
// (relative /decisions) instead of downloading. A bare file with no such meta still works
// offline via download — this only turns on when served.
const captureMeta = `<meta name="aio-doc-review-capture" content="${token}">`;
const servedHtml = artifactHtml.includes('</head>')
  ? artifactHtml.replace('</head>', `${captureMeta}\n</head>`)
  : `${captureMeta}\n${artifactHtml}`;

const OVERALL_LABEL = {
  approved: 'APPROVED',
  changes_requested: 'CHANGES REQUESTED',
  rejected: 'REJECTED',
};

function flat(value) {
  return String(value == null ? '' : value).replace(/\s*[\r\n\u2028\u2029\u0085\v\f]+\s*/g, ' ').trim();
}

/** Render the canonical feedback block from a decisions payload (mirrors the app's renderer). */
function renderBlock(payload) {
  const lines = [];
  const overall = payload.overall && OVERALL_LABEL[payload.overall] ? OVERALL_LABEL[payload.overall] : 'CHANGES REQUESTED';
  lines.push(`## Document review feedback — ${flat(payload.title) || '(untitled)'} (review ${payload.reviewId || 'n/a'})`);
  lines.push(`Overall: ${overall}`);
  let n = 0;
  for (const item of Array.isArray(payload.items) ? payload.items : []) {
    const comment = flat(item && item.comment);
    if (!item || (!item.decision && !comment)) continue;
    n += 1;
    const verb = item.decision === 'approve' ? 'approve' : item.decision === 'reject' ? 'reject' : 'note';
    let line = `${n}. [${flat(item.title) || flat(item.id)}] ${verb}`;
    if (comment) line += ` — ${comment}`;
    lines.push(line);
  }
  const general = flat(payload.general);
  if (general) lines.push(`General: ${general}`);
  return lines.join('\n');
}

function isLoopback(remoteAddress) {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

const server = createServer((req, res) => {
  if (!isLoopback(req.socket.remoteAddress || '')) {
    res.writeHead(403).end();
    return;
  }
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(servedHtml);
    return;
  }

  if (req.method === 'POST' && url === '/decisions') {
    if (req.headers['x-aio-review-token'] !== token) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'bad token' }));
      return;
    }
    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        aborted = true;
        res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'too large' }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (aborted) return;
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'bad json' }));
        return;
      }
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
        res.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'bad shape' }));
        return;
      }
      try {
        await writeFile(decisionsPath, JSON.stringify(payload, null, 2));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(err) }));
        return;
      }
      process.stdout.write(`\n${renderBlock(payload)}\n`);
      process.stdout.write(`AIO_REVIEW_CAPTURED ${decisionsPath}\n`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404).end();
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.stdout.write(`AIO_REVIEW_URL http://127.0.0.1:${port}/\n`);
  process.stderr.write(`Doc-review server ready at http://127.0.0.1:${port}/ — open it, review, click Submit.\n`);
});

const shutdownTimer = setTimeout(() => {
  process.stderr.write('Doc-review server timed out; shutting down.\n');
  server.close(() => process.exit(0));
}, TIMEOUT_MS);
shutdownTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
