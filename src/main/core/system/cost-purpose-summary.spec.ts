import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { CostPurposeSummaryService,getCostPurposeSummary } from './cost-purpose-summary';
import { _resetCostAttributionForTesting,recordCostAttribution } from './cost-attribution';
let dir:string;
const time=Date.parse('2026-10-10T12:00:00Z');
function write(rows:object[],day='2026-10-10') {
  fs.writeFileSync(join(dir,`cost-attribution-${day}.jsonl`),rows.map(row=>JSON.stringify({ts:time,...row})).join('\n')+'\npartial');
}
beforeEach(()=>{
  dir=fs.mkdtempSync(join(tmpdir(),'cost-purpose-'));vi.stubEnv('AIO_COST_ATTRIBUTION_DIR',dir);
  vi.stubEnv('AIO_COST_ATTRIBUTION','1');_resetCostAttributionForTesting();CostPurposeSummaryService._resetForTesting();

});
afterEach(()=>{CostPurposeSummaryService._resetForTesting();_resetCostAttributionForTesting();
  vi.unstubAllEnvs();fs.rmSync(dir,{recursive:true,force:true});});
describe('CostPurposeSummary',()=>{
  it('groups purposes/providers, separates cache counts, estimates, unknown and free calls',()=>{
    write([
      {source:'one-shot',taskType:'review-orchestration',provider:'claude',usage:{inputTokens:10,cacheReadTokens:20,cacheWriteTokens:30,outputTokens:40,cost:1},costKnown:true},
      {source:'one-shot',taskType:'another',purpose:'review',provider:'codex',costSource:'priced',usage:{cost:2}},
      {source:'one-shot',taskType:'chat:x',provider:'copilot',costSource:'unknown',usage:{cost:0}},
      {source:'auxiliary',taskType:'aux:compression',provider:'aio-basic-summary',costSource:'free',usage:{cost:0}},
      {source:'auxiliary',taskType:'aux:compression',provider:'local-fallback'},
      {taskType:'reservation',auxiliarySpendReservationUsd:1},
      {taskType:'review-dispatch',reviewDispatch:true},{taskType:'verdict',reviewLifecycle:'verdict'},
    ]);
    const result=getCostPurposeSummary().getSummary({startTime:time-1,endTime:time+1});
    expect(result.totals).toMatchObject({calls:4,inputTokens:10,cacheReadTokens:20,cacheWriteTokens:30,
      outputTokens:40,cost:3,estimatedCost:2,estimatedShare:2/3,unknownCostCalls:1,freeCalls:1});
    expect(result.byPurpose[0]).toMatchObject({key:'review',calls:2,cost:3});
    expect(result.byProvider.find(row=>row.key==='copilot')?.unknownCostCalls).toBe(1);
  });
  it('only rereads changed day files and filters exact ranges',()=>{
    write([{taskType:'chat',usage:{cost:1}}]);
    fs.utimesSync(join(dir,'cost-attribution-2026-10-10.jsonl'),time/1000,time/1000);
    const service=getCostPurposeSummary();
    expect(service.getSummary({endTime:time+1}).totals.calls).toBe(1);
    expect(service.getSummary({startTime:time+1,endTime:time+2}).totals.calls).toBe(0);
    write([{taskType:'chat',usage:{cost:9}}]);
    fs.utimesSync(join(dir,'cost-attribution-2026-10-10.jsonl'),time/1000,time/1000);
    expect(service.getSummary({endTime:time+1}).totals.cost).toBe(1);
    write([{taskType:'chat',usage:{cost:1}},{taskType:'child',usage:{cost:2}}]);
    expect(service.getSummary({endTime:time+1}).totals.cost).toBe(3);

  });
  it('follows live attribution writes and exposes the opt-out',()=>{
    const service=getCostPurposeSummary();expect(service.getSummary().totals.calls).toBe(0);
    recordCostAttribution({source:'one-shot',taskType:'verify',provider:'claude',costSource:'provider',usage:{cost:0.5}});
    expect(service.getSummary().totals.cost).toBe(0.5);
    vi.stubEnv('AIO_COST_ATTRIBUTION','0');expect(service.getSummary().enabled).toBe(false);
  });
});
