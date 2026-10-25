import { EventEmitter } from 'events';
import { expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import type { InstanceSendInputOptions } from '../instance/instance-input-cancellation';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { trackConsult } from '../work-admission/consult-admission';
import { WorkAdmission } from '../work-admission/work-admission';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { createGlobalPauseRuntime } from '../global-pause/global-pause-runtime';
import { GlobalPauseService } from '../global-pause/global-pause-service';
import { GlobalPauseStore } from '../global-pause/global-pause-store';

const ports=vi.hoisted(()=>({store:null as unknown,runner:null as unknown,revive:vi.fn(),control:vi.fn()}));
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/ai-orchestrator-test'},powerMonitor:new EventEmitter()}));
vi.mock('../plugins/hook-emitter',()=>({emitPluginHook:vi.fn()}));
vi.mock('../session/session-revival-service',()=>({SessionRevivalService:class{revive=ports.revive;}}));
vi.mock('../session/session-queue-service',()=>({getSessionQueueService:()=>({reassignQueue:vi.fn()})}));
vi.mock('./index',()=>({getAutomationStore:()=>ports.store,getAutomationRunner:()=>ports.runner}));
vi.mock('../session/session-admission-service',()=>({getSessionAdmissionService:()=>({registerRedeliveryHandler:vi.fn(),admitAutomatedWrite:()=>({kind:'admitted',admissionId:'receipt'}),markDelivered:vi.fn(),markFailed:vi.fn()})}));

vi.mock('../plan-queue/plan-queue-coordinator',()=>({getPlanQueueCoordinator:()=>({control:ports.control})}));

type PickupTiming='before-engine'|'checkpoint'|'consult'|'startup-settle'|'engine-settle';
const cases=([ 'before-engine','checkpoint','consult','startup-settle','engine-settle'] as PickupTiming[])
  .flatMap(timing=>[false,true].map(finished=>({timing,finished,dispatched:true})));
cases.push({timing:'consult',finished:false,dispatched:false});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

it.each(cases)('leaves manually picked-up work alone during collection: %j',async({timing,finished,dispatched})=>{
  GlobalPauseService._resetForTesting();WorkAdmission._resetForTesting();resetAutomationEventsForTesting();ports.control.mockReset();
  const db=defaultDriverFactory(':memory:');createTables(db);createMigrationsTable(db);runMigrations(db);
  const store=new AutomationStore(db,{prepare:async()=>[],replacePrepared:()=>undefined,listForAutomation:async()=>[]} as never);
  const sending=deferred(),earlierStop=deferred(),releaseEarlier=deferred();
  const providerMessages:string[]=[];
  const chat={id:'chat',displayName:'Chat',workingDirectory:'/tmp',provider:'codex',status:'busy',parentId:null,outputBuffer:[] as {type:string;content:string;timestamp:number}[]};
  let sends=0;
  const sendInput=vi.fn(async(_id:string,prompt:string,_attachments:unknown,options:InstanceSendInputOptions={})=>{
    if(++sends===1){
      if(dispatched){options.beforeProviderDispatch?.();providerMessages.push(prompt);}
      sending.resolve();
      await new Promise<void>((_resolve,reject)=>options.signal?.addEventListener('abort',()=>reject(options.signal?.reason),{once:true}));
    }else{
      options.signal?.throwIfAborted();options.beforeProviderDispatch?.();providerMessages.push(prompt);
      if(finished){
        chat.status='idle';chat.outputBuffer.push({type:'assistant',content:'James new task finished',timestamp:Date.now()});
        manager.emit('provider:normalized-event',{instanceId:'chat',event:{kind:'output',messageType:'assistant',content:'James new task finished'}});
        manager.emit('provider:normalized-event',{instanceId:'chat',event:{kind:'complete'}});
      }
    }
  });
  let waits=0;
  const waitForInstanceSettled=vi.fn(async(_id:string,options?:{signal?:AbortSignal})=>{
    waits++;
    if((timing==='startup-settle'&&waits===1)||(timing==='engine-settle'&&waits===2)){
      earlierStop.resolve();
      await new Promise<void>((_resolve,reject)=>{
        if(options?.signal?.aborted)reject(options.signal.reason);
        else options?.signal?.addEventListener('abort',()=>reject(options.signal?.reason),{once:true});
      });
    }
    return {...chat,status:'idle'};
  });
  const terminateInstance=vi.fn();
  const manager=Object.assign(new EventEmitter(),{sendInput,terminateInstance,getAllInstances:()=>[chat],getInstance:()=>chat,interruptInstance:vi.fn(),waitForInstanceSettled});
  ports.revive.mockResolvedValue({status:'live',instanceId:'chat',restoreMode:'native-resume'});
  const runner=new AutomationRunner(store,undefined,Date.now,undefined,undefined,undefined,undefined,()=>false,async(_run,_store,dispatch)=>dispatch());
  runner.initialize(manager as unknown as InstanceManager);ports.store=store;ports.runner=runner;
  const automation=await store.create({name:'Wake',schedule:{type:'cron',expression:'0 * * * *',timezone:'UTC'},destination:{kind:'thread',instanceId:'chat',reviveIfArchived:true},action:{prompt:'Original wakeup',workingDirectory:'/tmp'}},1000);
  const firing=runner.fire(automation.id,{trigger:'manual'});await sending.promise;const run=store.listActiveRuns()[0];
  const runtime=createGlobalPauseRuntime(manager as unknown as InstanceManager);runtime.level=()=>3;runtime.runningWork=undefined;
  runtime.engines=async()=>[...(timing==='checkpoint'?[{kind:'queue-run' as const,id:'queue',displayName:'Queue'}]:[]),{kind:'automation-run',id:run.id,displayName:'Wake'}];
  const service=GlobalPauseService.getInstance({store:new GlobalPauseStore(db),runtime});
  let terminalEvents=0;
  getAutomationEvents().on('automation:run-terminal',({runId}:{runId:string})=>{terminalEvents++;service.voidTarget(runId,'scheduled-job-ended');});
  let interruptsAtPickup=0;
  const pickUp=async():Promise<void>=>{
    interruptsAtPickup=manager.interruptInstance.mock.calls.length;
    service.manualInput('chat');await manager.sendInput('chat','James replacement task',undefined,{});
  };
  let releaseConsult:(()=>void)|undefined;
  if(timing==='consult')releaseConsult=trackConsult(()=>{earlierStop.resolve();});
  if(timing==='checkpoint')ports.control.mockImplementation(async({action}:{action:string})=>{if(action==='pause'){earlierStop.resolve();await releaseEarlier.promise;}});
  if(timing==='before-engine'){
    const original=runtime.pauseEngines;
    runtime.pauseEngines=async entries=>{await pickUp();await original(entries);};
  }
  const pausing=service.pauseForRestart({withNotes:false});
  if(timing!=='before-engine'){
    await earlierStop.promise;expect(service.getState().phase).toBe('collecting');
    await pickUp();releaseEarlier.resolve();releaseConsult?.();
  }
  await pausing;await firing;
  expect(manager.interruptInstance).toHaveBeenCalledTimes(interruptsAtPickup);
  expect(chat.status).toBe(finished?'idle':'busy');
  expect(store.getRun(run.id)?.status).toBe('cancelled');
  expect(service.getState().phase).toBe('ready');
  expect(service.getState().entries.find(entry=>entry.kind==='session')?.state).toBe('void');
  expect(service.listenerCount('state-changed')).toBe(0);
  await service.resume();
  expect(providerMessages).toEqual([...(dispatched?['Original wakeup']:[]),'James replacement task']);
  expect(terminateInstance).not.toHaveBeenCalled();expect(terminalEvents).toBe(1);
  GlobalPauseService._resetForTesting();WorkAdmission._resetForTesting();resetAutomationEventsForTesting();db.close();
});
