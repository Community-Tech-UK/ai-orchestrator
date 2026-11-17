#!/usr/bin/env node
'use strict';

/**
 * A stand-in for the Claude CLI that reports a provider usage limit, for live tests of the limit
 * handler. Harness only uses it when it sits at `<live-test profile>/live-test-overrides/claude`
 * (see `resolveLiveTestClaudeStandIn`); install it with:
 *
 *   mkdir -p "$AIO_DEV_USER_DATA_PATH/live-test-overrides" &&
 *   install -m 700 scripts/remote-checks/claude-limit-stand-in.js "$AIO_DEV_USER_DATA_PATH/live-test-overrides/claude"
 *
 * Do this before creating the session: the choice is made when the session is created.
 *
 * Behaviour: answers `--version` and `--help`; otherwise speaks the stream-json protocol. On each
 * user message it replies with a rejected `rate_limit_event` whose reset is
 * AIO_STAND_IN_RESET_MINUTES (default 3) ahead, then a 429 error result. It never contacts a provider.
 * Each reply is appended to AIO_STAND_IN_LOG when that is set, so a test can see whether it ran.
 */

const fs = require('node:fs');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');

const args = process.argv.slice(2);
const log = (event, detail = {}) => {
  const file = process.env.AIO_STAND_IN_LOG;
  if (file) fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...detail })}\n`);
};

if (args.includes('--version')) {
  log('version');
  process.stdout.write('2.1.999 (Claude Code)\n');
  process.exit(0);
}
if (args.includes('--help')) {
  log('help');
  process.stdout.write('Usage: claude [options]\n  --exclude-dynamic-system-prompt-sections\n');
  process.exit(0);
}

const flagValue = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sessionId = flagValue('--session-id') || flagValue('--resume') || randomUUID();
const minutes = Number(process.env.AIO_STAND_IN_RESET_MINUTES) > 0 ? Number(process.env.AIO_STAND_IN_RESET_MINUTES) : 3;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let initialised = false;

log('start', { sessionId, args: args.filter(arg => arg.startsWith('--')) });
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;
  if (!initialised) {
    initialised = true;
    send({ type: 'system', subtype: 'init', session_id: sessionId, claude_code_version: '2.1.999', model: 'live-test-stand-in', tools: [] });
  }
  const resetsAt = Math.floor(Date.now() / 1000) + minutes * 60;
  send({ type: 'rate_limit_event', session_id: sessionId, rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } });
  send({
    type: 'result', subtype: 'success', is_error: true, api_error_status: 429, session_id: sessionId,
    result: "You've hit your limit", duration_ms: 1, num_turns: 1, total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  log('limit-reported', { resetsAt });
});
lines.on('close', () => { log('exit'); process.exit(0); });
process.on('SIGTERM', () => { log('exit'); process.exit(0); });
