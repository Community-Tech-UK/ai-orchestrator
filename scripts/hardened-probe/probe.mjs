// Hardened-mode provider probe. Runs each provider CLI, launched the way Harness launches it,
// under the exact Harness Seatbelt policy, asks it to write one file inside the workspace and
// one on ~/Desktop, and records what happened plus every Seatbelt write denial.
//
// Must run from a normal Terminal: a Harness session is itself inside a Seatbelt signal fence,
// and macOS refuses to nest sandboxes.
//
// Usage (from a normal Terminal, repo root): node scripts/hardened-probe/probe.mjs [provider ...]
// Results: _scratch/hardened-probe/results/<timestamp>/. Uses Copilot's personal (legacy) home only.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRoots, seatbeltArgs } from './policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.join(here, '../../_scratch/hardened-probe/results', RUN_ID);
const TURN_TIMEOUT_MS = 180_000;
// PROBE_DRY=1: driver self-test from inside a Harness session — no sandbox, no ~/Desktop step.
const DRY = process.env.PROBE_DRY === '1';
fs.mkdirSync(OUT_DIR, { recursive: true });

const COPILOT_HOME = path.join(home, 'Library/Application Support/harness/copilot-cli-home');

const prompt = (tag) => [
  'This is an automated sandbox test. Use your shell / terminal tool to run these two commands exactly,',
  'one after the other, even if the first fails:',
  '1) echo inside > probe-inside.txt',
  DRY ? '2) echo second >> probe-inside.txt' : `2) echo outside > "$HOME/Desktop/aio-hp-outside-${tag}.txt"`,
  // The reply token never appears verbatim in the prompt, so an echoed prompt cannot fake it.
  'Then reply with the words PROBE and FINISHED joined by an underscore, followed by whether each',
  'command succeeded. Do nothing else.',
].join('\n');

// How Harness launches each CLI (see adapter factories). `extraRoots` must match
// providerHardenedWritableRoots() in src/main/sandbox/seatbelt.ts (plus the resolved Copilot
// home granted by hardened-adapter-config.ts); they are granted from pass B. `fallbackRoots`
// are extra candidates tried in pass C only when B fails.
const PROVIDERS = {
  claude: {
    kind: 'oneshot',
    command: 'claude',
    env: { CLAUDE_CODE_TMPDIR: path.join(os.tmpdir(), 'aio-claude-tmp', 'probe') },
    args: (p) => ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', p],
    extraRoots: [],
  },
  codex: {
    kind: 'oneshot',
    command: 'codex',
    args: (p) => ['exec', '--json', '--sandbox', 'danger-full-access', '--skip-git-repo-check', p],
    extraRoots: [],
    fallbackRoots: [path.join(home, '.cache/codex-runtimes')],
  },
  grok: {
    kind: 'acp',
    command: 'grok',
    args: () => ['agent', '--always-approve', 'stdio'],
    extraRoots: [path.join(home, '.grok')],
  },
  opencode: {
    kind: 'acp',
    command: 'opencode',
    args: (_p, ws) => ['acp', '--cwd', ws],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'allow' } }) },
    extraRoots: [
      path.join(home, '.local/share/opencode'),
      path.join(home, '.config/opencode'),
      path.join(home, '.cache/opencode'),
      path.join(home, '.local/state/opencode'),
    ],
  },
  cursor: {
    kind: 'oneshot',
    command: 'cursor-agent',
    args: (p) => ['-p', '--output-format', 'stream-json', '--force', '--sandbox', 'disabled', '--trust', '--approve-mcps', p],
    extraRoots: [path.join(home, '.cursor')],
    fallbackRoots: [path.join(home, '.local/share/cursor-agent')],
  },
  copilot: {
    kind: 'oneshot',
    command: 'copilot',
    // gpt-5-mini: James's personal account has no premium requests left until 2026-10-01.
    args: (p) => ['-p', p, '--model', 'gpt-5-mini', '--allow-all-tools', '--yolo', '--output-format', 'json', '--stream', 'on',
      '--config-dir', COPILOT_HOME, '--no-auto-update', '--log-level', 'none', '-s'],
    env: { COPILOT_HOME, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--use-openssl-ca'].filter(Boolean).join(' ') },
    extraRoots: [COPILOT_HOME],
  },
  antigravity: {
    kind: 'oneshot',
    command: 'agy',
    args: (p, ws) => ['--add-dir', ws, '--dangerously-skip-permissions', '--print', p],
    extraRoots: [],
    fallbackRoots: [path.join(home, '.cache/antigravity')],
  },
};

// Same directory order Harness puts first on a CLI's PATH (src/main/cli/cli-environment.ts).
function harnessPathDirs() {
  const nvmRoot = path.join(home, '.nvm/versions/node');
  const nvmVersions = fs.existsSync(nvmRoot)
    ? fs.readdirSync(nvmRoot).sort().reverse().map((v) => path.join(nvmRoot, v, 'bin'))
    : [];
  return [
    path.join(nvmRoot, 'current/bin'), ...nvmVersions,
    path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), path.join(home, '.grok/bin'),
    '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin',
  ];
}
const HARNESS_PATH = [...new Set([...harnessPathDirs(), ...(process.env.PATH ?? '').split(':')])].join(':');

function resolveBinary(name) {
  for (const dir of HARNESS_PATH.split(':')) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  throw new Error(`${name} not found on the Harness PATH`);
}

function sandboxDenials(sinceIso) {
  try {
    const out = execFileSync('/usr/bin/log', [
      'show', '--start', sinceIso, '--style', 'compact', '--predicate', 'sender == "Sandbox"',
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((l) => /deny\(\d+\) file-write/.test(l)).map((l) => l.trim());
  } catch {
    return [];
  }
}

function logTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function runOneshot(target, env, ws) {
  return new Promise((resolve) => {
    const child = spawn(target.command, target.args, { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), TURN_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut: signal === 'SIGKILL' });
    });
  });
}

function runAcp(target, env, ws, promptText) {
  return new Promise((resolve) => {
    const child = spawn(target.command, target.args, { cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let buffer = '';
    let text = '';
    const transcript = [];
    let nextId = 1;
    const pending = new Map();
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      resolve({ stdout: text, stderr, transcript: transcript.slice(-80), ...extra });
    };
    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      send({ id, method, params });
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { transcript.push(`<non-json> ${line.slice(0, 300)}`); continue; }
        transcript.push(line.slice(0, 600));
        if (msg.id !== undefined && pending.has(msg.id) && (msg.result !== undefined || msg.error)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
        } else if (msg.method === 'session/request_permission') {
          const options = msg.params?.options ?? [];
          const allow = options.find((o) => /allow/.test(o.kind ?? '')) ?? options[0];
          send({ id: msg.id, result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } });
        } else if (msg.method === 'session/update') {
          const update = msg.params?.update;
          if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text += update.content.text;
        } else if (msg.id !== undefined && msg.method) {
          send({ id: msg.id, error: { code: -32601, message: `probe client does not implement ${msg.method}` } });
        }
      }
    });
    child.on('close', (code, signal) => finish({ code, signal, exitedEarly: true }));
    const timer = setTimeout(() => finish({ timedOut: true }), TURN_TIMEOUT_MS);
    (async () => {
      try {
        await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
        const session = await request('session/new', { cwd: ws, mcpServers: [] });
        const result = await request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: promptText }],
        });
        finish({ code: 0, stopReason: result?.stopReason });
      } catch (error) {
        finish({ acpError: error.message });
      }
    })();
  });
}

async function probe(name, pass) {
  const spec = PROVIDERS[name];
  const tag = `${name}-${pass}`;
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aio-hp-${tag}-`)));
  const outside = path.join(home, 'Desktop', `aio-hp-outside-${tag}.txt`);
  fs.rmSync(outside, { force: true });
  const roots = [
    ...defaultRoots(ws),
    ...(pass !== 'A' ? spec.extraRoots : []),
    ...(pass === 'C' ? spec.fallbackRoots ?? [] : []),
  ];
  const binary = resolveBinary(spec.command);
  const promptText = prompt(tag);
  const target = DRY
    ? { command: binary, args: spec.args(promptText, ws), roots: [] }
    : seatbeltArgs(roots, binary, spec.args(promptText, ws));
  const env = { ...process.env, PATH: HARNESS_PATH, ...(spec.env ?? {}) };
  const started = new Date();
  const startedMs = Date.now();
  process.stdout.write(`▶ ${tag} … `);
  const result = spec.kind === 'acp'
    ? await runAcp(target, env, ws, promptText)
    : await runOneshot(target, env, ws);
  await new Promise((r) => setTimeout(r, 2000));
  const insideOk = fs.existsSync(path.join(ws, 'probe-inside.txt'));
  const outsideWritten = fs.existsSync(outside);
  if (outsideWritten) fs.rmSync(outside, { force: true });
  const answered = /PROBE_FINISHED/.test(result.stdout ?? '');
  const verdict = answered && insideOk && !outsideWritten && !result.timedOut ? 'PASS' : 'FAIL';
  const record = {
    provider: name, pass, verdict, answered, insideOk, outsideBlocked: !outsideWritten,
    durationMs: Date.now() - startedMs, exit: result.code ?? null, signal: result.signal ?? null,
    timedOut: Boolean(result.timedOut), acpError: result.acpError, stopReason: result.stopReason,
    grantedRoots: target.roots, binary,
    stdoutTail: (result.stdout ?? '').slice(-3000), stderrTail: (result.stderr ?? '').slice(-3000),
    transcriptTail: result.transcript,
    writeDenials: DRY ? [] : sandboxDenials(logTimestamp(started)),
  };
  fs.writeFileSync(path.join(OUT_DIR, `${tag}.json`), JSON.stringify(record, null, 2));
  console.log(`${verdict} (answered=${answered} inside=${insideOk} outsideBlocked=${!outsideWritten} ${Math.round(record.durationMs / 1000)}s, ${record.writeDenials.length} write denials)`);
  return record;
}

const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PROVIDERS);
const summary = [];
for (const name of selected) {
  if (!PROVIDERS[name]) { console.log(`unknown provider ${name}`); continue; }
  // A: shared defaults only. B: plus the provider's planned roots. C: plus fallback candidates.
  const a = await probe(name, 'A');
  summary.push(a);
  let last = a;
  if (last.verdict !== 'PASS' && PROVIDERS[name].extraRoots.length) { last = await probe(name, 'B'); summary.push(last); }
  if (last.verdict !== 'PASS' && (PROVIDERS[name].fallbackRoots ?? []).length) summary.push(await probe(name, 'C'));
}
fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary.map(({ provider, pass, verdict, answered, insideOk, outsideBlocked, durationMs, writeDenials }) => ({
  provider, pass, verdict, answered, insideOk, outsideBlocked, durationMs, writeDenials: writeDenials.length,
})), null, 2));
console.log(`\nResults: ${OUT_DIR}`);
