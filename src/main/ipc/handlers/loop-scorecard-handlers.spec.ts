import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { runLoopMigrations } from '../../orchestration/loop-schema';
const state = vi.hoisted(()=>({db:null as SqliteDriver|null,handler:null as ((event:unknown,payload:unknown)=>Promise<{success:boolean;data?:unknown}>)|null}));
vi.mock('electron',()=>({ipcMain:{handle:(_channel:string,handler:typeof state.handler)=>{state.handler=handler;}}}));
vi.mock('../../orchestration/loop-store',()=>({getLoopStoreService:()=>({getDb:()=>state.db})}));
import { registerLoopScorecardHandlers } from './loop-scorecard-handlers';
afterEach(()=>{state.db?.close();state.db=null;});
describe('scorecard read-only IPC',()=>{
  it('rejects empty identity and returns null for unknown runs',async()=>{
    state.db=new Database(':memory:') as unknown as SqliteDriver;runLoopMigrations(state.db); registerLoopScorecardHandlers();
    expect((await state.handler!(null,{loopRunId:''})).success).toBe(false);
    expect(await state.handler!(null,{loopRunId:'absent'})).toEqual({success:true,data:{scorecard:null}});
    state.db.prepare("INSERT INTO loop_runs (id,chat_id,config_json,status,started_at,total_cost_cents,total_tokens) VALUES ('run','chat','{}','completed',1,15,20)").run();
    expect(await state.handler!(null,{loopRunId:'run'})).toMatchObject({success:true,data:{scorecard:{costCents:15,unattributedCents:15,tokens:20}}});
  });
});
