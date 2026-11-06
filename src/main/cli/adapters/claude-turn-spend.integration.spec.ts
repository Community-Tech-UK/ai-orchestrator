import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./claude-transcript-registry', async original => ({
  ...await original<typeof import('./claude-transcript-registry')>(), nativeTranscriptExists: () => true,
}));
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
import { ClaudeCliAdapter } from './claude-cli-adapter';
import type { CliResponse } from './base-cli-adapter';
class CompletingClaudeAdapter extends ClaudeCliAdapter {
  finalize(response: CliResponse): void { this.completeResponse(response); }
  prepareForkRuntime(): string[] { return this.buildArgs({ role: 'user', content: 'fork invocation' }); }
}
describe('Claude actual completion accounting', () => {
  it('reads the source cost-state for a native fork and differences its model totals through completion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fork-cost-seed-')); directories.push(directory);
    const cwd = join(directory, 'workspace'); mkdirSync(cwd);
    const project = join(directory, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')); mkdirSync(project, { recursive: true });
    const models = { main: { inputTokens: 100, costUSD: 0.4 }, side: { inputTokens: 50, costUSD: 0.1 } };
    writeFileSync(join(project, 'source-session.jsonl'), JSON.stringify({ type: 'cost-state', totalCostUSD: 0.5, modelUsage: models }) + '\n');
    const adapter = new CompletingClaudeAdapter({ model: 'sonnet', sessionId: 'source-session', resume: true,
      forkSession: true, workingDirectory: cwd, env: { CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_TMPDIR: join(directory, 'tmp') } });
    const completed: CliResponse[] = []; adapter.on('complete', value => completed.push(value));
    expect(adapter.prepareForkRuntime()).toContain('--fork-session');
    const receipt = (total: number, modelUsage: object) => adapter.parseOutput(JSON.stringify({ type: 'result',
      session_id: 'new-native-fork', total_cost_usd: total, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage }));
    adapter.finalize(receipt(0.5, models));
    adapter.finalize(receipt(0.75, { main: { inputTokens: 110, costUSD: 0.6 }, side: { inputTokens: 60, costUSD: 0.15 } }));
    expect(completed.map(response => response.usage?.cost)).toEqual([0, 0.25]);
    expect(completed[1].usage?.byModel?.map(delta => delta.inputTokens)).toEqual([10, 10]);
  });
  it('parses purely then emits per-turn dollars and preserved stop/quota metadata', () => {
    const adapter = new CompletingClaudeAdapter({ model:'sonnet' });
    const completed: CliResponse[] = []; adapter.on('complete',value=>completed.push(value));
    const raw = (total:number, terminal_reason:string) => JSON.stringify({type:'result',terminal_reason,total_cost_usd:total,usage:{input_tokens:10,output_tokens:20}});
    const first = adapter.parseOutput(raw(0.5,'completed')); const duplicateParse = adapter.parseOutput(raw(0.5,'completed'));
    expect(first.usage?.cost).toBeUndefined(); expect(duplicateParse.usage?.cost).toBeUndefined();
    adapter.finalize(first); adapter.finalize(adapter.parseOutput(raw(1.25,'max_turns')));
    expect(completed.map(value=>value.usage?.cost)).toEqual([0.5,0.75]);
    expect(completed[1].metadata?.['finishReason']).toBe('max_turns');
    const quota = adapter.parseOutput(JSON.stringify({type:'result',terminal_reason:'budget_exhausted',is_error:true,api_error_status:429,result:'limit'}));
    expect(quota.metadata).toMatchObject({finishReason:'budget_exhausted',quota:{exhausted:true}});
  });
});
