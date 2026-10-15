import { describe, expect, it } from 'vitest';
import { ClaudeCliAdapter } from './claude-cli-adapter';
import type { CliResponse } from './base-cli-adapter';
class CompletingClaudeAdapter extends ClaudeCliAdapter {
  finalize(response: CliResponse): void { this.completeResponse(response); }
}
describe('Claude actual completion accounting', () => {
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
