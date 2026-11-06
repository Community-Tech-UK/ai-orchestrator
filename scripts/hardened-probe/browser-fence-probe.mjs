// Proves the signal fence's Playwright Chromium exception, using the policy Harness ships.
//
// Must run from a normal Terminal: a Harness session is itself inside the fence, and macOS
// refuses to nest sandboxes. Needs Node 24 (it imports the TypeScript policy directly).
//
// Usage (repo root): node scripts/hardened-probe/browser-fence-probe.mjs [folder with playwright]
// Default folder: ../../communitytech/work-finding/apps/desk. Exits 0 only if every check passes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNAL_FENCE_EXEC, SIGNAL_FENCE_POLICY } from '../../src/main/sandbox/signal-fence.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(process.argv[2] ?? path.join(here, '../../../../communitytech/work-finding/apps/desk'));
const OLD_POLICY = SIGNAL_FENCE_POLICY.split('\n').filter((line) => !line.includes('no-sandbox')).join('\n');

const outer = spawnSync(SIGNAL_FENCE_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']);
if (outer.status !== 0) {
  console.error('This shell is already inside a sandbox. Run this from a normal Terminal, not a Harness session.');
  process.exit(2);
}

// Each launch runs as its own Node process so that it can sit inside a fence.
const launcher = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-fence-probe-')), 'launch.mjs');
fs.writeFileSync(launcher, `
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(${JSON.stringify(path.join(project, 'package.json'))})('playwright');
const options = { headless: true, chromiumSandbox: true, timeout: 20000 };
// Only a plain launch passes the browser's own error output on, so this is the mode that shows the refusal.
if (process.argv[2] === 'refusal') {
  const browser = await chromium.launch(options);
  await browser.newPage();
  console.log(JSON.stringify({ text: 'ready' }));
  process.exit(0);
}
const server = await chromium.launchServer(options);
const browser = await chromium.connect(server.wsEndpoint());
const page = await browser.newPage();
await page.goto('data:text/html,<main>ready</main>', { timeout: 10000 });
const text = await page.locator('main').textContent({ timeout: 10000 });
const pid = server.process().pid;
const helpers = execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\\n').map(Number);
if (process.argv[2] === 'force') await server.kill(); else await server.close();
console.log(JSON.stringify({ text, pid, helpers }));
process.exit(0);
`);

function launch(policy, mode = 'close') {
  const node = process.execPath;
  const args = [launcher, mode];
  const options = { encoding: 'utf8', timeout: 60_000, env: { ...process.env, DEBUG: 'pw:browser' } };
  const run = policy
    ? spawnSync(SIGNAL_FENCE_EXEC, ['-p', policy, '--', node, ...args], options)
    : spawnSync(node, args, options);
  const stderr = run.stderr ?? '';
  const refused = stderr.includes('sandbox initialization failed');
  const line = (run.stdout ?? '').trim().split('\n').pop() ?? '';
  try {
    return { ...JSON.parse(line), refused };
  } catch {
    return { refused, error: stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200) };
  }
}

const gone = (pid) => {
  try { process.kill(pid, 0); return false; } catch { return true; }
};

// Awaits rather than blocks: Node only notices a child has died while its event loop runs.
async function signalBlocked() {
  const fenced = spawnSync(SIGNAL_FENCE_EXEC, ['-p', SIGNAL_FENCE_POLICY, '--', '/usr/bin/true']);
  if (fenced.status !== 0) return false;
  const victim = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const stopped = () => victim.exitCode !== null || victim.signalCode !== null;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
  spawnSync(SIGNAL_FENCE_EXEC, ['-p', SIGNAL_FENCE_POLICY, '--', '/bin/kill', '-TERM', String(victim.pid)]);
  await settle();
  const blocked = !stopped();
  // Control: the same signal from outside the fence must land, or the check above proves nothing.
  spawnSync('/bin/kill', ['-TERM', String(victim.pid)]);
  await settle();
  const landed = stopped();
  victim.kill('SIGKILL');
  return blocked && landed;
}

process.on('exit', () => fs.rmSync(path.dirname(launcher), { recursive: true, force: true }));

const bare = launch(null);
const before = launch(OLD_POLICY, 'refusal');
const after = launch(SIGNAL_FENCE_POLICY);
const forced = launch(SIGNAL_FENCE_POLICY, 'force');
spawnSync('/bin/sleep', ['1']);

const checks = [
  ['Sandboxed Chromium works with no fence', bare.text === 'ready', bare.error],
  ['The fence without the exception breaks it (the reported fault)', before.refused && before.text !== 'ready', before.error ?? before.text],
  ['The fence with the exception lets it work', after.text === 'ready', after.error],
  ['A forced stop from inside the fence ends the browser', forced.text === 'ready' && forced.helpers.length > 0 && [forced.pid, ...forced.helpers].every(gone), forced.error ?? `pids ${forced.pid} ${forced.helpers}`],
  ['A fenced program still cannot stop an outside program', await signalBlocked()],
];

for (const [name, passed, note] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${!passed && note ? ` (${note})` : ''}`);
}
process.exit(checks.every(([, passed]) => passed) ? 0 : 1);
