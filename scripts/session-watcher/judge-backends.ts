import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractChatCompletionText, suppressReasoning } from '../../src/shared/utils/openai-response';
import { buildClaudeCliArgs } from '../../src/main/cli/adapters/claude-cli-argv-builder';
import { watcherJudgeSpawnOptions } from '../../src/main/session-watcher/watcher-judge-options';
import type { ParsedArgs } from './jsonl';

export interface JudgeCallOptions { maxTokens: number; temperature: number; timeoutMs: number }

/** One completion call. Throws on any failure, including empty content. */
export interface JudgeBackend {
  readonly name: string;
  readonly defaultConcurrency: number;
  call(system: string, user: string, options: JudgeCallOptions): Promise<string>;
}

/**
 * The request body the app sends to a local OpenAI-compatible model
 * (`generateOpenAiCompatibleOnWorker`, src/worker-agent/worker-auxiliary-generate.ts):
 * `suppressReasoning` is imported from the app; the rest mirrors the body there.
 */
export function buildOpenAiBody(model: string, system: string, user: string, options: JudgeCallOptions, jsonFormat: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: suppressReasoning(system) }, { role: 'user', content: user }],
    temperature: options.temperature,
    reasoning_effort: 'none',
    max_tokens: options.maxTokens,
    stream: false,
  };
  if (jsonFormat) body['response_format'] = { type: 'json_object' };
  return body;
}

/** True when a chat-completions reply is the server rejecting `response_format`. */
function rejectsResponseFormat(text: string): boolean {
  return text.includes('response_format');
}

/** Runs a shell command, feeding `stdin`; kills the child when the time is up. */
function runCommand(command: string, args: string[], stdin: string, timeoutMs: number, cwd?: string, shell = false): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    // Own process group, so a timeout can kill a shell's children too (an ssh behind a shell would otherwise keep the pipes open).
    const child = spawn(command, args, { cwd, shell, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!timedOut) resolve({ stdout, stderr, code });
    });
    child.stdin.on('error', () => { /* child exited early; close handler reports */ });
    child.stdin.end(stdin);
  });
}

function parseCompletion(raw: string): { text?: string; error?: string } {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { error: `response was not JSON (${raw.length} chars)` }; }
  const err = (data as { error?: unknown } | null)?.error;
  if (err) return { error: typeof err === 'string' ? err : JSON.stringify(err).slice(0, 500) };
  try { return { text: extractChatCompletionText(data) }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/** Sends a request body, retrying once without `response_format` when the server objects to it. */
async function withJsonFormatRetry(send: (body: Record<string, unknown>) => Promise<string>, make: (jsonFormat: boolean) => Record<string, unknown>): Promise<string> {
  const first = parseCompletion(await send(make(true)));
  if (first.text !== undefined) return first.text;
  if (first.error && rejectsResponseFormat(first.error)) {
    const second = parseCompletion(await send(make(false)));
    if (second.text !== undefined) return second.text;
    throw new Error(second.error ?? 'no content');
  }
  throw new Error(first.error ?? 'no content');
}

class OpenAiCompatibleBackend implements JudgeBackend {
  readonly name = 'openai-compatible';
  readonly defaultConcurrency = 2;
  constructor(private readonly baseUrl: string, private readonly model: string) {}
  async call(system: string, user: string, options: JudgeCallOptions): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      return await withJsonFormatRetry(async (body) => {
        const resp = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
        });
        const text = await resp.text();
        // A non-2xx reply that is not JSON must still read as a failure.
        if (!resp.ok && !text.trim().startsWith('{')) return JSON.stringify({ error: `HTTP ${resp.status}` });
        return text;
      }, (jsonFormat) => buildOpenAiBody(this.model, system, user, options, jsonFormat));
    } finally { clearTimeout(timer); }
  }
}

/** Same request, but the body goes to a shell command's stdin and the reply is read from its stdout. */
class OpenAiViaCommandBackend implements JudgeBackend {
  readonly name = 'openai-via-command';
  readonly defaultConcurrency = 2;
  constructor(private readonly command: string, private readonly model: string) {}
  async call(system: string, user: string, options: JudgeCallOptions): Promise<string> {
    const deadline = Date.now() + options.timeoutMs;
    return withJsonFormatRetry(async (body) => {
      const remaining = Math.max(1, deadline - Date.now());
      const { stdout, code, stderr } = await runCommand(this.command, [], JSON.stringify(body), remaining, undefined, true);
      if (!stdout.trim()) throw new Error(`command gave no output (exit ${code}${stderr ? `, stderr ${stderr.length} chars` : ''})`);
      return stdout;
    }, (jsonFormat) => buildOpenAiBody(this.model, system, user, options, jsonFormat));
  }
}

/**
 * The installed `claude` binary as a plain one-shot completion: print mode, no
 * tools, no skills, no MCP servers, no settings files, no saved session, our
 * system prompt in place of the default, run in an empty temporary directory.
 * The user prompt goes on stdin. Mirrors the title service's one-shot call
 * (`--print`, replaced system prompt, no yolo, a budget cap). The CLI has no
 * temperature or output-token flag, so those options are not applied.
 */
class ClaudeCliBackend implements JudgeBackend {
  readonly name = 'claude-cli';
  readonly defaultConcurrency = 3;
  constructor(private readonly model: string, private readonly binary: string) {}
  async call(system: string, user: string, options: JudgeCallOptions): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'session-watcher-claude-'));
    try {
      const args = [
        '--print', '--output-format', 'text', '--model', this.model, '--system-prompt', system,
        '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '',
        '--no-session-persistence', '--max-budget-usd', '0.50',
      ];
      const { stdout, code, stderr } = await runCommand(this.binary, args, user, options.timeoutMs, dir);
      const text = stdout.trim();
      if (code !== 0 || !text) throw new Error(`claude exited ${code}${stderr ? ` (stderr ${stderr.length} chars)` : ''}${text ? '' : ', empty output'}`);
      return text;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

/**
 * The judge exactly as the app calls it: the command line comes from the app's own argument builder and the
 * watcher's own spawn options (model, plain completion, replaced system prompt, empty folder, budget), and the
 * prompt goes in as one stream-json user message, as the app's adapter writes it. Scores from this backend
 * describe the configuration that ships. `--model` is ignored: the pinned model is part of what is measured.
 */
class ClaudeAppBackend implements JudgeBackend {
  readonly name = 'claude-app';
  readonly defaultConcurrency = 3;
  constructor(private readonly binary: string) {}
  async call(system: string, user: string, options: JudgeCallOptions): Promise<string> {
    const spawnOptions = watcherJudgeSpawnOptions(system);
    const args = buildClaudeCliArgs({
      spawnOptions, sessionId: null, excludeDynamicSectionsSupported: null, cliVersion: null, disallowedToolsOverride: null,
      shouldUseNativeResume: false, shouldUsePermissionHook: false, materializeInlineJsonArg: (value: string) => value,
    });
    const input = `${JSON.stringify({ type: 'user', message: { role: 'user', content: user } })}\n`;
    const { stdout, code, stderr } = await runCommand(this.binary, args, input, options.timeoutMs, spawnOptions.workingDirectory);
    let result: string | undefined;
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const event = JSON.parse(line) as { type?: string; result?: unknown; is_error?: boolean };
        if (event.type === 'result' && typeof event.result === 'string' && event.is_error !== true) result = event.result;
      } catch { /* a torn line is skipped */ }
    }
    if (!result?.trim()) throw new Error(`claude exited ${code}${stderr ? ` (stderr ${stderr.length} chars)` : ''}, no result`);
    return result.trim();
  }
}

/**
 * The installed `codex` binary as a one-shot completion, used as a labeller from
 * a second provider. It has no system-prompt flag, so the system text leads the
 * prompt on stdin. The user's own Codex config and rules are ignored (no MCP
 * servers, no helper agents), the sandbox is read-only, nothing is saved, and it
 * runs in an empty temporary directory. Temperature and output limit do not apply.
 */
class CodexCliBackend implements JudgeBackend {
  readonly name = 'codex-cli';
  readonly defaultConcurrency = 3;
  constructor(private readonly model: string, private readonly binary: string) {}
  async call(system: string, user: string, options: JudgeCallOptions): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'session-watcher-codex-'));
    try {
      const out = join(dir, 'last-message.txt');
      const args = [
        'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
        '-m', this.model, '-c', 'model_reasoning_effort=low', '-o', out, '-',
      ];
      const { code, stderr } = await runCommand(this.binary, args, `${system}\n\n${user}`, options.timeoutMs, dir);
      let text = '';
      try { text = readFileSync(out, 'utf8').trim(); } catch { /* no reply was written */ }
      if (code !== 0 || !text) throw new Error(`codex exited ${code}${stderr ? ` (stderr ${stderr.length} chars)` : ''}${text ? '' : ', empty output'}`);
      return text;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

export function createBackend(args: ParsedArgs): JudgeBackend {
  const backend = args.flags.get('backend');
  if (backend === 'claude-app') return new ClaudeAppBackend(args.flags.get('claude-binary') ?? 'claude');
  const model = args.flags.get('model');
  if (!model) throw new Error('missing --model');
  if (backend === 'claude-cli') return new ClaudeCliBackend(model, args.flags.get('claude-binary') ?? 'claude');
  if (backend === 'codex-cli') return new CodexCliBackend(model, args.flags.get('codex-binary') ?? 'codex');
  if (backend === 'openai-compatible') {
    const baseUrl = args.flags.get('base-url');
    if (!baseUrl) throw new Error('--backend openai-compatible needs --base-url');
    return new OpenAiCompatibleBackend(baseUrl, model);
  }
  if (backend === 'openai-via-command') {
    const command = args.flags.get('command');
    if (!command || command === 'true') throw new Error('--backend openai-via-command needs --command "<shell command>"');
    return new OpenAiViaCommandBackend(command, model);
  }
  throw new Error('--backend must be claude-app, claude-cli, codex-cli, openai-compatible or openai-via-command');
}
