import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import Database from 'better-sqlite3';
import type {SqliteDriver} from '../db/sqlite-driver';
import type {Instance} from '../../shared/types/instance.types';
import {InstanceCommunicationManager} from '../instance/instance-communication';
import {getSessionAdmissionService,_resetSessionAdmissionServiceForTesting} from '../session/session-admission-service';
import {SessionAdmissionStore} from '../session/session-admission-store';
vi.mock('../logging/logger',()=>({getLogger:()=>({info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()})}));
vi.mock('../hooks/hook-manager',()=>({getHookManager:()=>({triggerHooks:vi.fn(),triggerLifecycleHooks:vi.fn().mockResolvedValue({blocked:false})})}));
vi.mock('../core/config/settings-manager',()=>({getSettingsManager:()=>({getAll:()=>({outputBufferSize:100,enableDiskStorage:false}),get:()=>undefined})}));
vi.mock('../memory/output-storage',()=>({getOutputStorageManager:()=>({storeMessages:vi.fn(),deleteInstance:vi.fn()})}));
vi.mock('../cli/adapters/copilot/copilot-account-home-resolver',()=>({resolveCopilotProfileHome:()=>'/disposable-copilot-home'}));
let db:Database.Database;
vi.mock('../persistence/rlm-database',()=>({getRLMDatabase:()=>({getRawDb:()=>db as unknown as SqliteDriver})}));
beforeEach(()=>{db=new Database(':memory:');SessionAdmissionStore._resetForTesting();_resetSessionAdmissionServiceForTesting();});
afterEach(()=>{_resetSessionAdmissionServiceForTesting();SessionAdmissionStore._resetForTesting();db.close();vi.restoreAllMocks();});

import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {GeminiCliAdapter} from '../cli/adapters/gemini-cli-adapter';
const native=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('node:http',()=>({request:native.request}));
afterEach(()=>{vi.unstubAllGlobals();native.request.mockReset();});

describe('actual Gemini event-owned recovery joins rejected send once',()=>{
 it.each(['overflow-success','overflow-failure','stop','manual-input','adapter-replaced','park','reentrant-error','observer-manual','old-request-error','ordinary-overflow-success','ordinary-park'] as const)('keeps recovery and persisted receipt truthful for %s',async scenario=>{
  const ordinary=scenario==='ordinary-overflow-success'||scenario==='ordinary-park';
  const mode=scenario==='ordinary-overflow-success'?'overflow-success':scenario==='ordinary-park'?'park':scenario;
  const adapter=new GeminiCliAdapter({timeout:1000});Object.assign(adapter,{isSpawned:true});
  const instance={id:'event-owned-'+scenario,parentId:null,launchMode:'orchestrated',provider:'gemini',sessionId:adapter.getSessionId(),adapterGeneration:0,restartEpoch:0,status:'idle',requestCount:4,lastActivity:0,errorCount:0,outputBuffer:[]} as unknown as Instance;
  let currentAdapter=adapter;let nativeInputs=0;
  const nativePrompts:string[]=[];
  (adapter as unknown as {spawnProcess:(args:string[])=>ChildProcess}).spawnProcess=args=>{
   nativePrompts.push(args[args.length-1]);
   nativeInputs++;const turn=nativeInputs;const child=new EventEmitter() as unknown as ChildProcess;child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
   queueMicrotask(()=>{
    if(turn===1 && mode==='old-request-error'){instance.requestCount++;instance.status='busy';}
    if(turn===1) child.stdout?.emit('data',Buffer.from(JSON.stringify({type:'result',status:'error',error:{message:mode==='park'?'usage limit reached':'context_length_exceeded'}})+'\n'));
    child.emit('close',turn===1||mode==='overflow-failure'?1:0,null);
   });return child;
  };
  const controller=new AbortController();let admissions=0;let compactions=0;
  const park=vi.fn(()=> 'parked' as const);
  let entered!:()=>void;const compactEntered=new Promise<void>(resolve=>{entered=resolve;});
  let release!:()=>void;const compactGate=new Promise<void>(resolve=>{release=resolve;});
  const outputs:Record<string,unknown>[]=[];
  const communication=new InstanceCommunicationManager({getInstance:()=>instance,getAdapter:()=>currentAdapter,setAdapter:()=>undefined,deleteAdapter:()=>false,queueUpdate:()=>undefined,processOrchestrationOutput:()=>undefined,onInterruptedExit:async()=>undefined,ingestToRLM:()=>undefined,ingestToUnifiedMemory:()=>undefined,onProviderLimitTurn:park,emitProviderRuntimeEvent:(_id,event)=>{
    if(event.kind==='error' && mode==='observer-manual'){instance.requestCount++;instance.status='busy';controller.abort();}
  },compactContext:async()=>{compactions++;entered();await compactGate;}});
  communication.setupAdapterEvents(instance.id,adapter);communication.on('output',({message})=>outputs.push(message));
  if(mode==='reentrant-error')adapter.once('error',()=>adapter.emit('error',new Error('other failure object from same native send')));
  const cleanup=vi.spyOn(communication,'forceCleanupAdapter');
  const service=getSessionAdmissionService();const recorded=vi.spyOn(service,'recordUserSend');const delivered=vi.spyOn(service,'markDelivered');const failed=vi.spyOn(service,'markFailed');
  const sending=communication.sendInput(instance.id,'Synthetic event-owned recovery',undefined,undefined,ordinary?undefined:{signal:controller.signal,beforeProviderDispatch:()=>admissions++});
  if(mode!=='park'&&mode!=='observer-manual'&&mode!=='old-request-error'){
   await compactEntered;
   if(mode==='stop'){instance.status='interrupting';controller.abort();}
   if(mode==='manual-input'){instance.requestCount++;controller.abort();}
   if(mode==='adapter-replaced'){currentAdapter=new GeminiCliAdapter();instance.adapterGeneration=(instance.adapterGeneration??0)+1;}
   if(mode==='stop'||mode==='manual-input'){
    await Promise.race([sending,new Promise((_,reject)=>setTimeout(()=>reject(new Error('cancelled send did not settle before compaction')),250))]);
    expect(nativeInputs).toBe(1);
   }
   release();
  }
  await sending;
  if(mode==='stop')expect(instance.status).toBe('interrupting');
  if(mode==='observer-manual'||mode==='old-request-error')expect(instance.status).toBe('busy');
  const rows=SessionAdmissionStore.getInstance(db as unknown as SqliteDriver).list({instanceId:instance.id});
  const success=mode==='overflow-success'||mode==='reentrant-error';
  expect(admissions).toBe(ordinary?0:1);expect(recorded).toHaveBeenCalledOnce();expect(rows).toHaveLength(1);expect(delivered).toHaveBeenCalledTimes(success?1:0);expect(failed).toHaveBeenCalledOnce();expect(rows[0].state).toBe(success?'delivered':'failed');
  expect(nativeInputs).toBe(success||mode==='overflow-failure'?2:1);expect(compactions).toBe(mode==='park'||mode==='observer-manual'||mode==='old-request-error'?0:1);expect(park).toHaveBeenCalledTimes(mode==='park'?1:0);
  if(mode==='park')expect(outputs.filter(o=>(o['metadata'] as Record<string,unknown>)?.['providerLimitParked'])).toHaveLength(1);
  if(ordinary){
   expect(nativePrompts).toEqual(Array(success?2:1).fill('Synthetic event-owned recovery'));
   expect(cleanup).not.toHaveBeenCalled();
   expect(outputs.filter(o=>(o['metadata'] as Record<string,unknown>)?.['fatal']===true)).toHaveLength(0);
   expect(instance.restartEpoch).toBe(0);
   expect(rows[0].deliveredAt===null).toBe(!success);
  }
  communication.cleanupCircuitBreaker(instance.id);await adapter.terminate(false);
 });
});
