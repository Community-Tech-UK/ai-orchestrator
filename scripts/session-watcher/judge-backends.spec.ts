import { describe, expect, it } from 'vitest';
import { buildOpenAiBody, createBackend } from './judge-backends';
import { parseArgs } from './jsonl';

const options = { maxTokens: 400, temperature: 0, timeoutMs: 5_000 };

describe('buildOpenAiBody', () => {
  it('mirrors the app request: no-think system prompt, reasoning off, json mode, no streaming', () => {
    const body = buildOpenAiBody('m', 'SYS', 'USER', options, true) as Record<string, unknown> & { messages: { role: string; content: string }[] };
    expect(body).toMatchObject({ model: 'm', temperature: 0, reasoning_effort: 'none', max_tokens: 400, stream: false, response_format: { type: 'json_object' } });
    expect(body.messages[0].content.startsWith('/no_think')).toBe(true);
    expect(body.messages[0].content).toContain('SYS');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'USER' });
    expect(buildOpenAiBody('m', 'SYS', 'USER', options, false)).not.toHaveProperty('response_format');
  });
});

// A command that reads the request from stdin and prints a chat-completions reply.
const cmd = (script: string) => `node -e ${JSON.stringify(script)}`;
const reply = (content: string) => `process.stdout.write(JSON.stringify({choices:[{message:{content:${JSON.stringify(content)}},finish_reason:'stop'}]}))`;
const viaCommand = (script: string) => createBackend(parseArgs(['--backend', 'openai-via-command', '--model', 'm', '--command', cmd(script)]));

describe('openai-via-command backend', () => {
  it('writes the request body to stdin and reads the reply from stdout', async () => {
    const backend = viaCommand(`let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const b=JSON.parse(d);process.stdout.write(JSON.stringify({choices:[{message:{content:b.model+':'+b.reasoning_effort+':'+b.stream},finish_reason:'stop'}]}))})`);
    expect(await backend.call('s', 'u', options)).toBe('m:none:false');
    expect(backend.defaultConcurrency).toBe(2);
  });

  it('retries once without response_format when the server rejects it', async () => {
    const backend = viaCommand(`let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const b=JSON.parse(d);process.stdout.write(b.response_format?JSON.stringify({error:{message:"'response_format.type' must be 'json_schema' or 'text'"}}):JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}))})`);
    expect(await backend.call('s', 'u', options)).toBe('ok');
  });

  it('treats empty content as a failure', async () => {
    await expect(viaCommand(reply('  ')).call('s', 'u', options)).rejects.toThrow(/empty content/);
  });

  it('kills the child on timeout', async () => {
    const started = Date.now();
    await expect(viaCommand('setTimeout(()=>{},60000)').call('s', 'u', { ...options, timeoutMs: 300 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('needs --command', () => {
    expect(() => createBackend(parseArgs(['--backend', 'openai-via-command', '--model', 'm']))).toThrow(/--command/);
  });
});
