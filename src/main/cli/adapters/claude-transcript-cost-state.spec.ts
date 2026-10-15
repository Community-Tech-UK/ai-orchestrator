import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const home = vi.hoisted(()=>({path:''}));
vi.mock('os',async(importOriginal)=>{const actual=await importOriginal<typeof import('os')>();return {...actual,default:{...actual,homedir:()=>home.path},homedir:()=>home.path};});
import { readLastClaudeCostState } from './claude-transcript-registry';
afterEach(()=>{if(home.path)rmSync(home.path,{recursive:true,force:true});home.path='';});
describe('bounded Claude native cost seed',()=>{
  it('reads the latest cost-state using CLI field names and ignores a partial tail',()=>{
    home.path=mkdtempSync('/tmp/aio-cost-seed-'); const cwd='/example/project';
    const directory=join(home.path,'.claude','projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'));mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,'session.jsonl'),`${JSON.stringify({type:'cost-state',totalCostUSD:0.5,modelUsage:{sonnet:{inputTokens:10}},sessionId:'session',startTime:1})}\n${JSON.stringify({type:'cost-state',totalCostUSD:1.25,modelUsage:{},sessionId:'session',startTime:1})}\n{"partial":`);
    expect(readLastClaudeCostState(cwd,'session')).toEqual({totalCostUSD:1.25,modelUsage:{}});
    expect(readLastClaudeCostState(cwd,'absent')).toBeUndefined();
    expect(readLastClaudeCostState(cwd,'../session')).toBeUndefined();
  });
});
