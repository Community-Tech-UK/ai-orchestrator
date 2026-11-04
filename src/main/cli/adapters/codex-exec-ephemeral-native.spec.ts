import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { CodexCliAdapter } from './codex-cli-adapter';
import type { CodexCliConfig } from './codex-adapter-config';
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function native(mode: 'failed' | 'partial' | 'cancelled') {
  mkdirSync(resolve('_scratch'), { recursive: true });
  const dir = mkdtempSync(resolve('_scratch/step13-native-')); directories.push(dir);
  const script = join(dir, 'native.cjs'); const file = join(dir, 'usage.jsonl');
  writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>{
    const out=e=>process.stdout.write(JSON.stringify(e)+'\\n');
    out({type:'thread.started',thread_id:'native-'+process.pid});
    out({type:'turn.completed',usage:{input_tokens:80,cached_input_tokens:60,output_tokens:10}});
    ${mode === 'failed' ? "out({type:'turn.failed',error:{message:'LOCAL_EXAMPLE_FAILURE'}});process.exitCode=1;" : "out({type:'item.completed',item:{type:'agent_message',text:'PRIVATE_EXAMPLE_CONTENT'}});setInterval(()=>{},1000);"}
  });`);
  const adapter = new CodexCliAdapter({ ephemeral: true, workingDir: dir, timeout: mode === 'partial' ? 350 : 1500, usageLogFile: file } as CodexCliConfig);
  const access = adapter as unknown as { config: { command: string; args: string[] } };
  access.config.command = process.execPath; access.config.args = [script];
  adapter.on('error', () => undefined);
  const rows = () => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return {adapter, rows, file};
}
describe('ephemeral usage from real exec processes', () => {
  it('records every failed native thread before retries, even with no assistant answer', async () => {
    const h = native('failed');
    try {
      await expect(h.adapter.sendMessage({ role: 'user', content: 'PRIVATE_EXAMPLE_PROMPT' })).rejects.toThrow('LOCAL_EXAMPLE_FAILURE');
      expect(h.rows()).toHaveLength(2);
      expect(new Set(h.rows().map(row => row.threadId)).size).toBe(2);
      expect(h.rows().every(row => row.tokens.total === 90 && row.requests === null && row.finishReason === 'exec-failed')).toBe(true);
    } finally { await h.adapter.terminate(false); }
  });
  it('records a partial timeout before returning its answer', async () => {
    const h = native('partial');
    try {
      const response = await h.adapter.sendMessage({ role: 'user', content: 'PRIVATE_EXAMPLE_PROMPT', metadata: { allowPartialOnTimeout: true } });
      expect(response.content).toBe('PRIVATE_EXAMPLE_CONTENT'); expect(response.metadata).toMatchObject({partial:true});
      expect(h.rows()).toMatchObject([{tokens:{input:80,cache:60,output:10,reasoning:null,total:90},helpers:{count:null},compactions:null}]);
      expect(readFileSync(h.file, 'utf8')).not.toContain('PRIVATE_EXAMPLE');
    } finally { await h.adapter.terminate(false); }
  });
  it('records a cancelled exec thread without accepting a second prompt', async () => {
    const h = native('cancelled'); const controller = new AbortController(); let output = false;
    h.adapter.on('output', () => { output = true; });
    try {
      const pending = h.adapter.sendMessage({ role: 'user', content: 'PRIVATE_EXAMPLE_PROMPT' }, { signal: controller.signal });
      const outcome = pending.catch(error => error);
      await vi.waitFor(() => expect(output).toBe(true)); controller.abort();
      expect((await outcome).name).toBe('AbortError');
      expect(h.rows()).toHaveLength(1); expect(h.rows()[0].tokens.total).toBe(90);
    } finally { await h.adapter.terminate(false); }
  });
});
