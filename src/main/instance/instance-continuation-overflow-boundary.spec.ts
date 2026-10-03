import type { Instance } from '../../shared/types/instance.types';
import type { AppServerClient } from '../cli/adapters/codex/app-server-client';
import type { AppServerNotification } from '../cli/adapters/codex/app-server-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { CodexCliAdapter } from '../cli/adapters/codex-cli-adapter';
import { InstanceContinuationRuntime } from './instance-continuation-runtime';
import { InstanceCommunicationManager } from './instance-communication';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
vi.mock('../cli/adapters/codex/app-server-client', async (importOriginal) => ({ ...await importOriginal<object>(), terminateProcessTree: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()}) }));

vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({triggerHooks:vi.fn(),triggerLifecycleHooks:vi.fn().mockResolvedValue({blocked:false})}) }));
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getSessionAdmissionService, _resetSessionAdmissionServiceForTesting } from '../session/session-admission-service';
import { SessionAdmissionStore } from '../session/session-admission-store';
let testDb: Database.Database;
vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => testDb as unknown as SqliteDriver }) }));
beforeEach(() => { testDb = new Database(':memory:'); SessionAdmissionStore._resetForTesting(); _resetSessionAdmissionServiceForTesting(); });
afterEach(() => { _resetSessionAdmissionServiceForTesting(); SessionAdmissionStore._resetForTesting(); testDb.close(); vi.restoreAllMocks(); });
vi.mock('../core/config/settings-manager', () => ({getSettingsManager:()=>({getAll:()=>({outputBufferSize:100,enableDiskStorage:false})})}));

vi.mock('../memory/output-storage',()=>({getOutputStorageManager:()=>({storeMessages:vi.fn(),deleteInstance:vi.fn()})}));


describe('actual communication overflow retry owner boundary', () => {
  it.each(['goal-update','stop','manual-input','success','retry-failure','inject-goal','inject-stop','inject-new-input'] as const)('keeps fallback ownership and receipt outcomes for %s', async (mode) => {
    const service = getSessionAdmissionService();
    const receipts = { record: vi.spyOn(service, 'recordUserSend'), delivered: vi.spyOn(service, 'markDelivered'), failed: vi.spyOn(service, 'markFailed') };
    const adapter = new CodexCliAdapter({timeout:2000});
    const subscribers = new Set<(n:AppServerNotification)=>void>();
    const requests:[string,Record<string,unknown>,boolean][]=[];
    let compacted=false;
    let turnStarts=0;
    const emit=(method:AppServerNotification['method'],params:Record<string,unknown>)=>{for(const fn of [...subscribers])fn({method,params});};
    const client={exitPromise:new Promise<void>(()=>undefined),request:async(method:string,params:Record<string,unknown>)=>{
      requests.push([method,params,compacted]);
      if (method === 'thread/inject_items' && compacted) {
        if (mode === 'inject-goal') emit('thread/goal/updated', { threadId: 'thread-overflow', goal: { status: 'active' } });
        if (mode === 'inject-stop' || mode === 'inject-new-input') events.emit(mode === 'inject-stop' ? 'instance:interrupt-requested' : 'instance:input-started', { instanceId: instance.id, autoContinuation: false });
      }
      if(method==='thread/goal/get')return {goal:null};
      if(method==='turn/start'){
        turnStarts++;
        if(turnStarts===1)throw new Error('context_length_exceeded');
        if (mode === 'retry-failure') throw new Error('synthetic retry failed');
        return {turn:{id:'retry-turn',status:'completed',items:[{id:'answer',type:'agentMessage',text:'Finished.'}]}};
      }
      return {};
    },subscribeNotifications:(fn:(n:AppServerNotification)=>void)=>{subscribers.add(fn);return()=>subscribers.delete(fn);},isRunning:()=>true,getPid:()=>4242};
    Object.assign(adapter,{appServerClient:client as unknown as AppServerClient,appServerThreadId:'thread-overflow',useAppServer:true,isSpawned:true});
    const internal=adapter as unknown as {appServerRuntime:{attach:(client:AppServerClient,binding:{threadId:string;resumeCursor:null;resumeProof:null},callback:(n:AppServerNotification)=>void)=>void};handleIdleAppServerNotification:(n:AppServerNotification)=>void};
    internal.appServerRuntime.attach(client as unknown as AppServerClient,{threadId:'thread-overflow',resumeCursor:null,resumeProof:null},(n:AppServerNotification)=>internal.handleIdleAppServerNotification(n));
    const instance={id:'root-overflow-'+mode,parentId:null,launchMode:'orchestrated',provider:'codex',sessionId:'thread-overflow',adapterGeneration:1,status:'idle',requestCount:3,lastActivity:0,outputBuffer:[]} as unknown as Instance;
    const events=new EventEmitter();
    let sent!:Promise<void>;
    let admitted=0;
    const communication=new InstanceCommunicationManager({getInstance:()=>instance,getAdapter:()=>adapter,setAdapter:()=>undefined,deleteAdapter:()=>false,queueUpdate:()=>undefined,processOrchestrationOutput:()=>undefined,onInterruptedExit:async()=>undefined,ingestToRLM:()=>undefined,ingestToUnifiedMemory:()=>undefined,compactContext:async()=>{
      compacted=true;
      if(mode==='goal-update')emit('thread/goal/updated',{threadId:'thread-overflow',goal:{status:'active'}});
    }});
    adapter.on('status',(status)=>{
      instance.status=status;
      if(compacted&&status==='busy'&&(mode==='stop'||mode==='manual-input'))queueMicrotask(()=>events.emit(mode==='stop'?'instance:interrupt-requested':'instance:input-started',{instanceId:instance.id,autoContinuation:false}));
    });
    const runtime=new InstanceContinuationRuntime(new InstanceAsyncWorkRegistry(),{
      on:events.on.bind(events),off:events.off.bind(events),getInstance:()=>instance,getAdapter:()=>adapter,
      waitForInstanceSettled:async()=>instance,
      sendInput:async (_id,prompt,_attachments,opts)=>{
        sent=communication.sendInput(instance.id,prompt,undefined,undefined,{...opts,beforeProviderDispatch:()=>{opts?.beforeProviderDispatch?.();admitted++;instance.requestCount++;}});
        await sent;
      },
    });
    runtime.start();
    try {
      events.emit('provider:normalized-event',{instanceId:instance.id,provider:'codex',event:{kind:'complete',requestCountAtCompletion:3,turnEnding:{reason:'max_output',evidence:'native_max_output'}}});
      await vi.waitFor(()=>expect(sent).toBeDefined());
      if (mode === 'retry-failure') await expect(sent).rejects.toThrow('synthetic retry failed'); else await sent;
      const retried = mode === 'success' || mode === 'retry-failure';
      expect(turnStarts).toBe(retried ? 2 : 1);
      expect(admitted).toBe(1); expect(receipts.record).toHaveBeenCalledOnce();
      expect(receipts.delivered).toHaveBeenCalledTimes(mode === 'success' ? 1 : 0);
      expect(receipts.failed).toHaveBeenCalledOnce();
      const persisted = SessionAdmissionStore.getInstance(testDb as unknown as SqliteDriver).list({ instanceId: instance.id });
      expect(persisted).toHaveLength(1); expect(persisted[0]?.state).toBe(mode === 'success' ? 'delivered' : 'failed');
      expect(persisted[0]?.deliveredAt === null).toBe(mode !== 'success');
      const retryWrites=requests.filter(([method,,afterCompact])=>afterCompact&&['thread/inject_items','turn/start','turn/steer'].includes(method));
      if (mode.startsWith('inject-')) {
        expect(retryWrites.map(([method]) => method)).toEqual(['thread/inject_items']);
      } else if (!retried) expect(retryWrites).toEqual([]);
      else {
        expect(retryWrites.filter(([method]) => method === 'turn/start')).toHaveLength(1);
        expect(requests.filter(([method]) => method === 'thread/inject_items').map(([, params]) => params['items'])).toEqual([requests.find(([method]) => method === 'thread/inject_items')?.[1]['items'], requests.find(([method]) => method === 'thread/inject_items')?.[1]['items']]);
      }
    } finally {runtime.stop();await adapter.terminate(false);}
  });
});
