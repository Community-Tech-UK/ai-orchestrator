import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
// Standalone audit is intentionally plain Node JavaScript.
// @ts-expect-error untyped standalone module
import { compareTranscriptCosts } from '../claude-transcript-cost-comparison.mjs';
const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'cost-transcript-')); dirs.push(root);
  const projects=join(root,'projects'); mkdirSync(join(projects,'repo','s1','subagents'),{recursive:true});
  const record=(id:string,usage:object, model='haiku')=>JSON.stringify({type:'assistant',sessionId:'s1',
    timestamp:'2026-10-09T12:00:00Z',message:{id,model,usage}});
  writeFileSync(join(projects,'repo','s1.jsonl'),[
    record('main',{input_tokens:100,output_tokens:10,cache_read_input_tokens:100,
      cache_creation_input_tokens:100,cache_creation:{ephemeral_5m_input_tokens:40,ephemeral_1h_input_tokens:60}}),
    record('main',{input_tokens:100000}),record('fake',{input_tokens:99999},'<synthetic>'),'partial{'].join('\n'));
  writeFileSync(join(projects,'repo','s1','subagents','agent-a.jsonl'),record('child',{input_tokens:100,output_tokens:10}));
  const alias=join(root,'alias');symlinkSync(projects,alias);
  symlinkSync(join(projects,'repo','s1.jsonl'),join(projects,'main-alias.jsonl'));
  return {roots:[projects,alias],start:Date.parse('2026-10-09T00:00:00Z'),end:Date.parse('2026-10-10T00:00:00Z')};
}
describe('transcript cost comparison',()=>{
  it('deduplicates real roots and message ids, splits subagents, skips synthetic and prices cache durations',()=>{
    const result=compareTranscriptCosts({...fixture(),rows:[{session_id:'s1',cost:0.00048}]});
    expect(result.main).toBeCloseTo(0.00033);expect(result.subagent).toBeCloseTo(0.00015);
    expect(result.transcript).toBeCloseTo(0.00048);expect(result.exceeded).toBe(false);
    expect(result.storedOnly).toEqual([]);expect(result.transcriptOnly).toEqual([]);
  });
  it('reports one-sided sessions and largest gaps with a threshold failure',()=>{
    const result=compareTranscriptCosts({...fixture(),rows:[{session_id:'missing',cost:1}]});
    expect(result.storedOnly).toEqual(['missing']);expect(result.transcriptOnly).toEqual(['s1']);
    expect(result.largestGaps[0].sessionId).toBe('missing');expect(result.exceeded).toBe(true);
    expect(result.caveats).toHaveLength(4);
  });
  it('accepts explicit price overrides',()=>{
    const result=compareTranscriptCosts({...fixture(),rows:[],prices:{haiku:{input:2,output:10}}});
    expect(result.transcript).toBeCloseTo(0.00096);
  });
  it('rejects invalid explicit prices instead of passing with NaN totals',()=>{
    expect(()=>compareTranscriptCosts({...fixture(),rows:[],prices:{haiku:{input:-1,output:10}}})).toThrow('Invalid price');
  });
  it('does not silently pass when transcripts are absent',()=>{
    const result=compareTranscriptCosts({rows:[{session_id:'s',cost:1}],roots:[],start:0,end:1});
    expect(result.gapPct).toBeNull();expect(result.exceeded).toBe(true);
  });
});
