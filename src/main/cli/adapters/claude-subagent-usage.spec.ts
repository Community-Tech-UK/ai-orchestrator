import { EventEmitter } from 'node:events';
import { describe,it,expect,vi } from 'vitest';
import { parseClaudeSubagentUsage,ClaudeSubagentUsageTracker,observeClaudeSubagentUsage,flushClaudeSubagentUsage } from './claude-subagent-usage';
const progress={type:'system',subtype:'task_progress',tool_use_id:'tool-1',usage:{total_tokens:100,tool_uses:2,duration_ms:300}};
describe('Claude subagent usage',()=>{
  it('does not misclassify later usage from a known bash task as a subagent',()=>{
    const tracker=new ClaudeSubagentUsageTracker();
    tracker.observe({subtype:'task_started',task_type:'local_bash',task_id:'bash-1'});
    expect(tracker.observe({...progress,tool_use_id:undefined,task_id:'bash-1'})).toBeNull();
    expect(tracker.flush()).toEqual([]);
  });
  it('parses progress without treating size as spend',()=>{
    expect(parseClaudeSubagentUsage(progress)).toEqual({toolUseId:'tool-1',finalContextTokens:100,toolUses:2,durationMs:300,final:false});
  });
  it('parses final notification camel counters and omits missing/invalid usage',()=>{
    expect(parseClaudeSubagentUsage({...progress,subtype:'task_notification',usage:{totalTokens:101,toolUses:3,durationMs:400}})?.final).toBe(true);
    expect(parseClaudeSubagentUsage({...progress,usage:undefined})).toBeNull();
    expect(parseClaudeSubagentUsage({...progress,usage:{total_tokens:-1,tool_uses:2,duration_ms:300}})).toBeNull();
  });
  it('flushes a foreground sample at result once and ignores a late duplicate notice',()=>{
    const host=new EventEmitter(), sample=vi.fn();host.on('subagent_usage',sample);
    observeClaudeSubagentUsage(host,progress);flushClaudeSubagentUsage(host);flushClaudeSubagentUsage(host);
    observeClaudeSubagentUsage(host,{...progress,subtype:'task_notification'});
    expect(sample).toHaveBeenCalledTimes(2);expect(sample.mock.calls[1][0]).toMatchObject({final:true,finalContextTokens:100});
  });
  it('aliases task ids to the tool id and records the latest sample',()=>{
    const tracker=new ClaudeSubagentUsageTracker();
    tracker.observe({type:'system',subtype:'task_started',task_type:'local_agent',task_id:'task-1',tool_use_id:'tool-1'});
    tracker.observe({...progress,tool_use_id:undefined,task_id:'task-1'});
    tracker.observe({...progress,usage:{total_tokens:200,tool_uses:4,duration_ms:600}});
    expect(tracker.flush()).toEqual([{toolUseId:'tool-1',finalContextTokens:200,toolUses:4,durationMs:600,final:true}]);
  });
});
