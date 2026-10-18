import { describe,it,expect,vi } from 'vitest';
import { ClaudeCliAdapter } from './claude-cli-adapter';
describe('Claude foreground subagent samples',()=>{
  it('emits progress and exactly one final sample at the provider result without a notification',()=>{
    const adapter=new ClaudeCliAdapter({workingDirectory:'/tmp',model:'haiku'});
    const emit=vi.fn();adapter.on('subagent_usage',emit);
    const ingress=adapter as unknown as {processCliMessage(message:unknown):void};
    ingress.processCliMessage({type:'system',subtype:'task_progress',tool_use_id:'agent-tool',usage:{total_tokens:100,tool_uses:2,duration_ms:300}});
    ingress.processCliMessage({type:'result',usage:{input_tokens:1,output_tokens:1},total_cost_usd:0.01});
    ingress.processCliMessage({type:'system',subtype:'task_notification',tool_use_id:'agent-tool',usage:{totalTokens:100,toolUses:2,durationMs:300}});
    expect(emit.mock.calls.map(call=>call[0].final)).toEqual([false,true]);
  });
});
