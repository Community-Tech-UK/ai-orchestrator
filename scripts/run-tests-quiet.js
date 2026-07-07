#!/usr/bin/env node
/**
 * Quiet test runner — errors-only output to keep agent/CI context small.
 *
 * Why this exists: `vitest run` with the default reporter prints a per-file
 * tree plus every test's console output. A full suite (~10k tests) dumps tens
 * of thousands of lines into whatever context is driving it (a CLI agent in
 * the app, CI logs, a human). The agent only needs one bit: did it pass, and
 * if not, which tests failed and why. This runner delivers exactly that.
 *
 * Two stages:
 *   B (deterministic, zero model calls): run the suite, redirect the child's full
 *      stdout/stderr to _scratch/test-run.log (the user's console only ever sees
 *      this script's curated summary), then use the exit code + vitest's JSON
 *      reporter to print a one-line green summary or ONLY the verbatim failures.
 *   A (local model): when there are failures, optionally add a TL;DR from an
 *      OpenAI-compatible model (Ollama / LM Studio). ADDITIVE — the trustworthy
 *      verbatim block always prints; the summary is a bonus, skipped silently if
 *      no model answers. The "0 cloud tokens" claim is printed ONLY when the host
 *      is verifiably on-box/LAN and the model isn't a known cloud proxy; otherwise
 *      a warning is shown. Failure payloads are redacted (best-effort) before send.
 *
 * Local model endpoint (stage A), resolved in order:
 *   1. AIO_AUX_LLM_URL   (exclusive override) e.g. http://192.168.1.50:11434
 *   2. The app's Settings → Auxiliary Models: enabled manual endpoints from
 *      settings.json (auxiliaryLlmEndpointsJson), then localhost Ollama unless
 *      auxiliaryLlmUseLocalhostOllama is false. (Worker-node models advertised
 *      only via the running app's heartbeat are NOT visible here — add the box
 *      as a manual endpoint, or use AIO_AUX_LLM_URL.)
 *   3. default http://127.0.0.1:11434
 * Auto-selected endpoints (from settings) are filtered to on-box/LAN hosts and
 * non-cloud models. AIO_AUX_LLM_URL is an explicit override and is honored as-is,
 * but the cost label stays honest (see stage A note above). Cloud-proxied Ollama
 * models (remote_host / `:cloud`) are skipped in auto-pick and flagged in override.
 * Model: AIO_AUX_LLM_MODEL, else auto-picked (first non-cloud model).
 * Disable stage A entirely with AIO_TEST_SUMMARY=0.
 *
 * Usage:
 *   node scripts/run-tests-quiet.js                      # full suite (+ preflight)
 *   node scripts/run-tests-quiet.js src/main/foo.spec.ts # targeted (skips preflight)
 *   npm run test:quiet -- src/main/foo.spec.ts
 *
 * Exit code mirrors vitest's, so CI / agents still see real pass/fail.
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH_DIR = path.join(ROOT, '_scratch');
const LOG_PATH = path.join(SCRATCH_DIR, 'test-run.log');
const JSON_PATH = path.join(SCRATCH_DIR, 'test-results.json');

// How much detail to surface without re-flooding context.
const MAX_FAILURES_SHOWN = 20;
const MAX_MSG_CHARS = 1200;

const passthroughArgs = process.argv.slice(2);
// A "targeted" run names specific files/paths; skip the slower full-gate preflight.
const isTargetedRun = passthroughArgs.some((a) => !a.startsWith('-'));
const hasExplicitCacheFlag = passthroughArgs.some((a) => a === '--cache' || a === '--no-cache');

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

function ensureScratch() {
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  for (const p of [LOG_PATH, JSON_PATH]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Run the cheap preflight checks quietly; print their output only on failure. */
function runPreflight() {
  const checks = [
    ['check-node.js', path.join('scripts', 'check-node.js')],
    ['verify-package-exports.js', path.join('scripts', 'verify-package-exports.js')],
  ];
  for (const [name, rel] of checks) {
    try {
      execFileSync(process.execPath, [path.join(ROOT, rel)], {
        cwd: ROOT,
        stdio: 'pipe',
      });
    } catch (err) {
      log(`✗ Preflight failed: ${name}`);
      const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
      if (out) log(out);
      process.exit(typeof err.status === 'number' ? err.status : 1);
    }
  }
}

/** Spawn vitest, tee combined output to the log file, resolve with the exit code. */
function runVitest() {
  return new Promise((resolve) => {
    const args = [
      'run',
      ...passthroughArgs,
      // Avoid stale Vitest result-cache file lists after large delete/rename
      // batches. Callers can still opt back in with an explicit cache flag.
      ...(hasExplicitCacheFlag ? [] : ['--no-cache']),
      // NB: no --silent. The child's stdout/stderr is redirected to the log FILE
      // (not the user's console), so in-test console output never floods context
      // but IS preserved in the log for genuine drill-down. --silent would drop it.
      '--reporter=default', // rich human detail -> captured to the log
      '--reporter=json',
      `--outputFile.json=${JSON_PATH}`,
    ];
    // Launch vitest's JS entry directly with the current Node binary instead of
    // going through `npx`. On Windows `npx` is `npx.cmd`, and modern Node
    // refuses to spawn a `.cmd` without a shell (ENOENT for bare `npx`, EINVAL
    // for `npx.cmd` since the CVE-2024-27980 hardening). `shell: true` would fix
    // that but re-parse args and mangle test paths containing spaces. Resolving
    // the `vitest.mjs` bin and running it under process.execPath sidesteps all
    // of it and is fully cross-platform (macOS/Linux behaviour is unchanged).
    const vitestBin = require.resolve('vitest/vitest.mjs');
    const child = spawn(process.execPath, [vitestBin, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.on('error', (err) => {
      try {
        logStream.end();
      } catch {
        /* ignore */
      }
      log(`✗ Failed to launch vitest: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => {
      try {
        logStream.end();
      } catch {
        /* ignore */
      }
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

/** Parse vitest's jest-compatible JSON report into a tidy failure list + totals. */
function readReport() {
  let raw;
  try {
    raw = fs.readFileSync(JSON_PATH, 'utf8');
  } catch {
    return null; // vitest may have crashed before writing
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const failures = [];
  for (const suite of data.testResults || []) {
    const file = suite.name ? path.relative(ROOT, suite.name) : '(unknown file)';
    for (const a of suite.assertionResults || []) {
      if (a.status === 'failed') {
        failures.push({
          file,
          title: a.fullName || a.title || '(unnamed test)',
          messages: Array.isArray(a.failureMessages) ? a.failureMessages : [],
        });
      }
    }
  }
  return {
    numTotalTests: data.numTotalTests ?? 0,
    numPassedTests: data.numPassedTests ?? 0,
    numFailedTests: data.numFailedTests ?? failures.length,
    numFiles: (data.testResults || []).length,
    failures,
  };
}

function formatFailures(failures) {
  const lines = [];
  const shown = failures.slice(0, MAX_FAILURES_SHOWN);
  for (const f of shown) {
    lines.push(`  ✗ ${f.file} › ${f.title}`);
    const msg = (f.messages[0] || '').trim();
    if (msg) {
      const clipped = msg.length > MAX_MSG_CHARS ? `${msg.slice(0, MAX_MSG_CHARS)}\n    …(truncated — see log)` : msg;
      for (const ml of clipped.split('\n')) lines.push(`    ${ml}`);
    }
    lines.push('');
  }
  if (failures.length > shown.length) {
    lines.push(`  …and ${failures.length - shown.length} more failed test(s) — see ${path.relative(ROOT, LOG_PATH)}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Stage A — local-model failure TL;DR. Best-effort, never blocks. Cost label is
// only asserted "0 cloud tokens" for verifiably on-box/LAN endpoints.
// ---------------------------------------------------------------------------

/** Read the app's persisted settings.json (Electron userData) if present, so the
 *  runner can honor the endpoints configured in Settings → Auxiliary Models
 *  (e.g. a LAN box) without needing an env var. Returns the parsed object or null. */
function readAppSettings() {
  const appData =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
  // Canonical dir first, then dev + legacy names.
  for (const dir of ['harness', 'harness-dev', 'Harness', 'ai-orchestrator']) {
    const file = path.join(appData, dir, 'settings.json');
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Ordered list of local base URLs to try, most-specific first.
 *  AIO_AUX_LLM_URL is an exclusive override; otherwise we use the app's
 *  configured manual endpoints (the Windows PC, if added in Settings) then
 *  localhost Ollama (unless disabled). Note: worker-node models advertised only
 *  via the running app's heartbeat are NOT visible to this standalone script —
 *  add the box as a manual endpoint in Settings, or set AIO_AUX_LLM_URL. */
function candidateBaseUrls() {
  const seen = new Set();
  const out = [];
  const add = (u) => {
    if (!u || typeof u !== 'string') return;
    const n = u.replace(/\/+$/, '');
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };

  if (process.env.AIO_AUX_LLM_URL) {
    add(process.env.AIO_AUX_LLM_URL);
    return out; // explicit override is exclusive
  }

  const settings = readAppSettings();
  if (settings) {
    let endpoints = [];
    try {
      endpoints = JSON.parse(settings.auxiliaryLlmEndpointsJson || '[]');
    } catch {
      endpoints = [];
    }
    for (const e of Array.isArray(endpoints) ? endpoints : []) {
      if (!e || e.enabled === false) continue;
      if (e.provider === 'local-fallback') continue;
      if (/:cloud$/i.test(e.id || '') || /:cloud$/i.test(e.model || '')) continue;
      // Auto-selected endpoints must be on-box/LAN — mirror the app's IPC guard so
      // a misconfigured public manual endpoint is never silently used.
      if (!isPrivateOrLocalhost(e.baseUrl)) continue;
      add(e.baseUrl);
    }
    if (settings.auxiliaryLlmUseLocalhostOllama !== false) add('http://127.0.0.1:11434');
  }

  if (out.length === 0) add('http://127.0.0.1:11434');
  return out;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** A cloud-proxied Ollama model (remote_host set, or `:cloud` tag) would route to
 *  the cloud and cost tokens — the opposite of what we want. Exclude those. */
function isCloudProxied(entry) {
  if (!entry) return false;
  if (entry.remote_host || entry.remote_model) return true;
  const name = entry.name || entry.id || '';
  return /:cloud$/i.test(name);
}

/** True only for loopback / RFC-1918 private / Tailscale-CGNAT / .local hosts.
 *  Mirrors the app's IPC guard so an endpoint we can't confirm is on-box/LAN is
 *  never treated as "local" for the zero-cloud-tokens claim. */
function isPrivateOrLocalhost(urlStr) {
  try {
    const h = new URL(urlStr).hostname.replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '::1' || /\.local$/i.test(h)) return true;
    const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127) // Tailscale CGNAT
    );
  } catch {
    return false;
  }
}

/** Best-effort scrub of common secret shapes before any output leaves the machine
 *  for a model endpoint. NOT a guarantee — defense in depth, not a redaction proof. */
function redactSecrets(text) {
  return String(text)
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[REDACTED KEY BLOCK]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED-AWS-KEY]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED-JWT]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|refresh[_-]?token|access[_-]?token)(["'\s]*[:=]\s*["']?)[^\s"']{6,}/gi,
      '$1$2[REDACTED]',
    );
}

/** Probe the endpoint; return { model, cloudProxied } or null if none/unreachable.
 *  cloudProxied is best-effort (name-based for the explicit override, authoritative
 *  via /api/tags remote_host otherwise) and feeds the honesty of the cost label. */
async function resolveLocalModel(base) {
  if (process.env.AIO_AUX_LLM_MODEL) {
    const model = process.env.AIO_AUX_LLM_MODEL;
    // The explicit override is honored, but still flagged if it names a cloud proxy
    // so we never falsely claim "0 cloud tokens".
    return { model, cloudProxied: isCloudProxied({ name: model }) };
  }
  // Ollama native tags first — it exposes remote_host so we can skip cloud proxies.
  try {
    const res = await fetchWithTimeout(`${base}/api/tags`, {}, 1500);
    if (res.ok) {
      const j = await res.json();
      const local = (j?.models || []).find((m) => !isCloudProxied(m));
      if (local?.name) return { model: local.name, cloudProxied: false };
    }
  } catch {
    /* fall through */
  }
  // OpenAI-compatible (LM Studio, or non-Ollama endpoints). Skip obvious cloud tags.
  try {
    const res = await fetchWithTimeout(`${base}/v1/models`, {}, 1500);
    if (res.ok) {
      const j = await res.json();
      const local = (j?.data || []).find((m) => !isCloudProxied(m));
      if (local?.id) return { model: local.id, cloudProxied: false };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** One generation attempt against a specific base+model. Returns text or null. */
async function tryGenerate(base, model, userContent) {
  const payload = {
    model,
    temperature: 0.1,
    // Generous headroom: some local models are "thinking" models that spend
    // tokens on reasoning before the answer; too low a cap yields empty content.
    max_tokens: 700,
    stream: false,
    messages: [
      {
        role: 'system',
        content:
          'You summarize failing test output for an engineer. In 1-4 short bullet points, give the most likely root cause(s) and the files/symbols to look at. Be terse. Do not restate full stack traces. If the failures are unrelated, group them.',
      },
      { role: 'user', content: userContent },
    ],
  };
  try {
    const res = await fetchWithTimeout(
      `${base}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      // Generous: a cold local model (large weights loading) can take tens of
      // seconds on first call. This is the failure path — a brief wait is fine.
      60_000,
    );
    if (!res.ok) return null;
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch {
    return null;
  }
}

async function summarizeFailuresLocally(failures) {
  if (process.env.AIO_TEST_SUMMARY === '0') return null;

  // Redact common secret shapes before anything leaves the machine for a model.
  const userContent = redactSecrets(
    failures
      .slice(0, MAX_FAILURES_SHOWN)
      .map((f) => `### ${f.file} › ${f.title}\n${(f.messages[0] || '').slice(0, MAX_MSG_CHARS)}`)
      .join('\n\n'),
  );

  // Try each configured/local endpoint until one yields a model and a summary.
  for (const base of candidateBaseUrls()) {
    const resolved = await resolveLocalModel(base);
    if (!resolved) continue;
    const text = await tryGenerate(base, resolved.model, userContent);
    if (text) {
      // "local" (and therefore the 0-cloud-tokens claim) is only asserted when the
      // host is verifiably on-box/LAN AND the model isn't a known cloud proxy.
      const local = isPrivateOrLocalhost(base) && !resolved.cloudProxied;
      return { text, model: resolved.model, host: base.replace(/^https?:\/\//, ''), local };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

async function main() {
  ensureScratch();
  if (!isTargetedRun) runPreflight();

  const started = Date.now();
  const exitCode = await runVitest();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const report = readReport();

  const failed = exitCode !== 0 || (report && report.numFailedTests > 0);

  if (!failed) {
    if (report) {
      log(`✓ ${report.numFiles} files · ${report.numPassedTests} tests passed in ${elapsed}s`);
    } else {
      log(`✓ tests passed in ${elapsed}s`);
    }
    log(`  full log: ${path.relative(ROOT, LOG_PATH)}`);
    process.exit(exitCode);
  }

  // Failure path.
  if (report && report.failures.length > 0) {
    log(`✗ ${report.numFailedTests} of ${report.numTotalTests} tests failed in ${elapsed}s:`);
    log('');
    log(formatFailures(report.failures));
  } else {
    // No JSON (vitest likely crashed). Show the tail of the log so we're not blind.
    log(`✗ test run failed (exit ${exitCode}) and produced no JSON report. Tail of log:`);
    try {
      const tail = fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(-40).join('\n');
      log(tail);
    } catch {
      /* ignore */
    }
  }
  log(`full log: ${path.relative(ROOT, LOG_PATH)}`);

  if (report && report.failures.length > 0) {
    const summary = await summarizeFailuresLocally(report.failures);
    if (summary) {
      const note = summary.local
        ? 'local model, 0 cloud tokens'
        : '⚠ endpoint not verified on-box/LAN — may incur cost';
      log('');
      log(`Model TL;DR (${summary.model} @ ${summary.host} · ${note}):`);
      for (const ml of summary.text.split('\n')) log(`  ${ml}`);
    }
  }

  // Contract: the exit code must reflect real pass/fail. vitest can exit 0
  // even when its JSON report contains failed tests (observed 2026-07-01 on
  // the full suite); without this floor the wrapper prints failures but
  // reports success to CI/agents.
  process.exit(exitCode !== 0 ? exitCode : 1);
}

main().catch((err) => {
  log(`✗ run-tests-quiet crashed: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
