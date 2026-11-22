// Paid probe (at most 8 turns / $0.50 per arm). Judge the receipts, not the exit code: four unique calls per arm, the failing show stays an error, the pipeline counts 2, diff is denied, and the ON arm's hook-decisions log shows two rewrites, one passthrough and one ignored-deny.
// Uses existing legitimate authentication and permissions; never changes account limits or user settings.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The bundled rtk binary for this machine. */
export function bundledRtkBinary(root = repo) {
  return join(root, 'resources/rtk', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rtk.exe' : 'rtk');
}

/**
 * The label the bundled binary must report. The version comes from
 * scripts/rtk-binaries.sha256.json, the pin `rtk-version-pins.spec.ts` keeps in
 * step with the other repository pins — never a version written down here.
 */
export function expectedRtkLabel(root = repo) {
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/rtk-binaries.sha256.json'), 'utf8'));
  return `rtk ${manifest.version}`;
}

export function runNativeHookProbe(io = console) {
  const evidence = join(repo, '_scratch/rtk-native-hook-probe');
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, 'guidance-rtk-live-'));
  const binary = bundledRtkBinary();
  const hook = join(repo, 'src/main/cli/hooks/rtk-defer-hook.mjs');
  const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
  const commands = ['git status --short', 'git show nonexistent-guidance-placeholder', "printf 'one\\ntwo\\n' | wc -l", 'git diff --stat'];
  const permissions = {
    allow: ['Bash(git status:*)', 'Bash(rtk git status:*)', 'Bash(git show:*)', 'Bash(rtk git show:*)', 'Bash(printf:*)', 'Bash(wc:*)', 'Bash(git diff:*)', 'Bash(rtk git diff:*)'],
    deny: ['Bash(git diff:*)', 'Bash(rtk git diff:*)'],
  };
  mkdirSync(join(root, '.claude'), { recursive: true });
  // RTK and Claude both read the same project-local deny rule; native user rules still apply as well.
  writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify({ permissions }, null, 2));
  const env = { ...process.env, PATH: `${dirname(binary)}${delimiter}${process.env.PATH ?? ''}`, RTK_TELEMETRY_DISABLED: '1',
    ORCHESTRATOR_RTK_ENABLED: '1', ORCHESTRATOR_RTK_PATH: binary, TMPDIR: root, XDG_DATA_HOME: join(root, 'data') };
  // Start from a clean hook environment; the ON arm sets exactly what the app's buildClaudeRtkEnv sets.
  delete env.ORCHESTRATOR_RTK_REWRITE_ONLY;
  delete env.ORCHESTRATOR_RTK_LOG_DIR;
  delete env.ORCHESTRATOR_DECISION_DIR;
  const version = spawnSync(binary, ['--version'], { env, encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== expectedRtkLabel()) {
    throw new Error(`Expected the bundled ${expectedRtkLabel()}; no upgrade is permitted.`);
  }
  const prompt = `Run exactly these four Bash tool calls, one per command, without retries or alternate commands, in this order:\n${commands.map((command, index) => `${index + 1}. ${command}`).join('\n')}\nThe second call must fail and the fourth must be denied. Stop after the four attempts. Do not start helpers or request permission changes. Report observed failure and count results.`;
  const receipts = [];
  for (const arm of ['off', 'on']) {
    const settings = join(root, `${arm}-overlay.json`);
    writeFileSync(settings, JSON.stringify(arm === 'on' ? { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(hook)}` }] }] } } : {}));
    // No settings-source suppression, account override or broad permission mode. Explicit grants remain subject to denies.
    const args = ['--print', '--no-session-persistence', '--verbose', '--output-format', 'stream-json', '--model', 'sonnet', '--max-turns', '8', '--max-budget-usd', '0.5',
      '--permission-mode', 'dontAsk', '--tools', 'Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', settings, '--', prompt];
    // The hook reads rewrite-only mode and its coverage-log folder from the environment, as rtk-rollout.ts buildClaudeRtkEnv sets them.
    const armEnv = arm === 'on' ? { ...env, ORCHESTRATOR_RTK_REWRITE_ONLY: '1', ORCHESTRATOR_RTK_LOG_DIR: join(root, 'hook-decisions') } : env;
    const result = spawnSync('claude', args, { cwd: root, env: armEnv, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(root, `${arm}.stdout.jsonl`), result.stdout ?? '');
    writeFileSync(join(root, `${arm}.stderr.log`), result.stderr ?? '');
    const rows = (result.stdout ?? '').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const calls = new Map(); const outcomes = new Map();
    for (const row of rows) for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (block.type === 'tool_use' && block.name === 'Bash') calls.set(block.id, block.input?.command);
      if (block.type === 'tool_result') outcomes.set(block.tool_use_id, { isError: block.is_error === true, content: block.content });
    }
    const final = rows.findLast(row => row.type === 'result');
    const receipt = { arm, exit: result.status, signal: result.signal, transportError: result.error?.code, resultIsError: final?.is_error,
      costUsd: final?.total_cost_usd, calls: [...calls].map(([id, command]) => ({ command, result: outcomes.get(id) })), expectedCalls: commands.length };
    receipts.push(receipt);
    writeFileSync(join(root, 'receipts.json'), JSON.stringify({ runtime: root, receipts }, null, 2));
    io.log(JSON.stringify({ runtime: root, arm, exit: result.status, resultIsError: final?.is_error, calls: calls.size }));
    // A transport/provider refusal ends the campaign immediately: no repeated paid retries or credential/limit changes.
    if (result.status !== 0 || final?.is_error || /monthly.*(?:spend|limit)|spend.*limit|usage limit/i.test((result.stdout ?? '') + (result.stderr ?? ''))) {
      process.exitCode = result.status || 1; break;
    }
    if (calls.size !== commands.length) { process.exitCode = 1; break; }
  }
  io.log(`Retain receipts for review, then remove ONLY this printed runtime directory: ${root}`);
  return root;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runNativeHookProbe();
