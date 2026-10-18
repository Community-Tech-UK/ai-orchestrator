import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CostPurposeRange, CostPurposeRow, CostPurposeSummary } from '../../../shared/types/cost-purpose.types';
import { getCostAttributionDirectory, getCostAttributionFilePath, purposeOf, subscribeCostAttribution,
  type CostAttributionRecord } from './cost-attribution';
interface DatedRecord extends CostAttributionRecord { ts:number }
interface CachedDay { size:number; mtime:number; rows:DatedRecord[] }
const number = (value:unknown):number => typeof value==='number' && Number.isFinite(value) && value>=0 ? value : 0;
function empty(key:string):CostPurposeRow {
  return {key,calls:0,inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,reasoningTokens:0,
    cost:0,estimatedCost:0,estimatedShare:0,unknownCostCalls:0,historicalCostUnknownCalls:0,freeCalls:0};
}
function isCall(record:DatedRecord):boolean {
  const marker=record as unknown as Record<string,unknown>;
  return typeof record.taskType==='string' && !('auxiliarySpendReservationUsd' in marker)
    && !marker['reviewDispatch'] && !marker['reviewLifecycle'] && !marker['subagentUsage']
    && record.provider!=='local-fallback' && record.auxRoutedTo!=='fallback';
}
function add(row:CostPurposeRow,record:DatedRecord):void {
  row.calls++;
  const usage=record.usage;
  for (const key of ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','reasoningTokens'] as const) {
    row[key]+=number(usage?.[key]);
  }
  // Legacy resident Claude logs booked cumulative totals and omitted native
  // session identity. They cannot safely be differenced by instance/model.
  // Preserve the logs, report those calls as unknown, and trust the explicit
  // cost-source tag written by the fixed per-turn producer for all new rows.
  const unreconciled = record.source === 'instance-turn' && record.costSource === undefined
    && (record.provider === 'claude' || record.provider === 'claude-cli');
  if (unreconciled) row.historicalCostUnknownCalls = (row.historicalCostUnknownCalls ?? 0) + 1;
  const source=unreconciled ? 'unknown' : record.costSource ?? (record.costKnown===false ? 'unknown' : typeof usage?.cost==='number' ? 'provider' : 'unknown');
  const known=source!=='unknown' && typeof usage?.cost==='number' && Number.isFinite(usage.cost) && usage.cost>=0;
  if (source==='free') row.freeCalls++;
  else if (!known) row.unknownCostCalls++;
  if (known) {
    row.cost+=usage.cost!;
    if (source==='priced' || record.isEstimated) row.estimatedCost+=usage.cost!;
    row.estimatedShare=row.cost>0 ? row.estimatedCost/row.cost : 0;
  }
}
/** Read-only cost-log view. Invalid/partial rows cannot break the Costs page. */
export class CostPurposeSummaryService {
  private static instance:CostPurposeSummaryService|null=null;
  private readonly cache=new Map<string,CachedDay>();
  private readonly unsubscribe=subscribeCostAttribution(()=>{
    const file=getCostAttributionFilePath();
    if (file) this.cache.delete(file);
  });
  static getInstance():CostPurposeSummaryService { return this.instance ??= new CostPurposeSummaryService(); }
  static _resetForTesting():void { this.instance?.unsubscribe(); this.instance=null; }
  getSummary(range:CostPurposeRange={}):CostPurposeSummary {
    const result:CostPurposeSummary={enabled:getCostAttributionFilePath()!==null,byPurpose:[],byProvider:[],totals:empty('all')};
    const directory=getCostAttributionDirectory();
    if (!directory || !existsSync(directory)) return result;
    const purposeRows=new Map<string,CostPurposeRow>();
    const providerRows=new Map<string,CostPurposeRow>();
    const start=range.startTime ?? 0, end=range.endTime ?? Date.now();
    try {
      for (const name of readdirSync(directory).filter(name=>/^cost-attribution-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))) {
        const day=Date.parse(name.slice(17,27)+'T00:00:00Z');
        if (day>end || day+86400000<=start) continue;
        const file=join(directory,name), stats=statSync(file);
        let cached=this.cache.get(file);
        if (!cached || cached.size!==stats.size || cached.mtime!==stats.mtimeMs) {
          const rows:DatedRecord[]=[];
          for (const line of readFileSync(file,'utf8').split('\n')) {
            try { const record=JSON.parse(line) as DatedRecord;
              if (record && typeof record==='object' && Number.isFinite(record.ts)) rows.push(record);
            } catch { /* Ignore incomplete append or malformed historical row. */ }
          }
          cached={size:stats.size,mtime:stats.mtimeMs,rows}; this.cache.set(file,cached);
        }
        for (const record of cached.rows) {
          if (record.ts<start || record.ts>end || !isCall(record)) continue;
          const purpose=purposeOf(record), provider=record.provider ?? 'unknown';
          if (!purposeRows.has(purpose)) purposeRows.set(purpose,empty(purpose));
          if (!providerRows.has(provider)) providerRows.set(provider,empty(provider));
          add(purposeRows.get(purpose)!,record);add(providerRows.get(provider)!,record);add(result.totals,record);
        }
      }
    } catch { /* A transient log I/O failure leaves the readable rows available. */ }
    result.byPurpose=[...purposeRows.values()] as CostPurposeSummary['byPurpose'];
    result.byProvider=[...providerRows.values()];
    result.byPurpose.sort((a,b)=>b.cost-a.cost || b.calls-a.calls);
    result.byProvider.sort((a,b)=>b.cost-a.cost || b.calls-a.calls);
    return result;
  }
}
export const getCostPurposeSummary=():CostPurposeSummaryService=>CostPurposeSummaryService.getInstance();
