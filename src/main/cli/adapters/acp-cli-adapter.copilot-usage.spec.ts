import { describe, it, expect } from 'vitest';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
const frames = [
  { inputTokens:100,cachedReadTokens:70,cachedWriteTokens:20,outputTokens:10,totalTokens:110 },
  { inputTokens:150,cachedReadTokens:100,cachedWriteTokens:30,outputTokens:20,totalTokens:170 },
];
async function harness(cumulative = true) {
  const proc = createInitializedAgentHarness(); let index = 0;
  proc.onRequest('session/prompt', message => proc.respond(message.id, {stopReason:'end_turn',usage:frames[Math.min(index++,1)]}));
  const adapter = new TestAcpCliAdapter(proc, {workingDirectory:'/tmp', ...(cumulative ? {promptUsageReporting:'session-cumulative-gross' as const} : {})});
  const contexts: { cumulativeTokens:number }[] = [];
  adapter.on('context', context => contexts.push(context)); await adapter.spawn();
  return { adapter, proc, contexts };
}
describe('Copilot ACP usage wiring', () => {
  it('settles for both completed usages and context instead of summing running totals', async () => {
    const {adapter,proc,contexts} = await harness();
    const first = await adapter.sendMessage({role:'user',content:'first'});
    const second = await adapter.sendMessage({role:'user',content:'second'});
    expect(first.usage).toMatchObject({inputTokens:10,outputTokens:10,cacheReadTokens:70,cacheWriteTokens:20});
    expect(second.usage).toMatchObject({inputTokens:10,outputTokens:10,cacheReadTokens:30,cacheWriteTokens:10,totalTokens:60});
    expect(contexts.map(c => c.cumulativeTokens)).toEqual([110,170]);
    const identical = await adapter.sendMessage({role:'user',content:'third'});
    expect(identical.usage).toBeUndefined(); proc.exit();
  });
  it('leaves per-turn OpenCode-profile usage unchanged', async () => {
    const {adapter,proc,contexts} = await harness(false);
    await adapter.sendMessage({role:'user',content:'first'});
    expect((await adapter.sendMessage({role:'user',content:'second'})).usage).toMatchObject({inputTokens:150,outputTokens:20,cacheReadTokens:100,cacheWriteTokens:30});
    expect(contexts.map(c => c.cumulativeTokens)).toEqual([110,280]); proc.exit();
  });
  it('does not reset on session/load or terminate, but session/new resets', async () => {
    const {adapter,proc} = await harness();
    await adapter.sendMessage({role:'user',content:'first'});
    const config = (adapter as unknown as {acpConfig:{resume?:boolean;sessionId?:string}}).acpConfig;
    config.resume = true; config.sessionId='sess-acp-1';
    await adapter.terminate(false); await adapter.spawn();
    expect((await adapter.sendMessage({role:'user',content:'loaded'})).usage).toMatchObject({inputTokens:10,outputTokens:10});
    config.resume = false;
    await adapter.terminate(false); await adapter.spawn();
    expect((await adapter.sendMessage({role:'user',content:'new'})).usage).toMatchObject({inputTokens:20,outputTokens:20}); proc.exit();
  });
});
