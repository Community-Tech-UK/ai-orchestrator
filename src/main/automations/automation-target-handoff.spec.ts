import { EventEmitter } from 'events';
import { expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import type { InstanceSendInputOptions } from '../instance/instance-input-cancellation';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { WorkAdmission } from '../work-admission/work-admission';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { createGlobalPauseRuntime } from '../global-pause/global-pause-runtime';
import { GlobalPauseService } from '../global-pause/global-pause-service';
import { GlobalPauseStore } from '../global-pause/global-pause-store';

const ports=vi.hoisted(()=>({store:null as unknown,runner:null as unknown,revive:vi.fn()}));
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/ai-orchestrator-test'},powerMonitor:new EventEmitter()}));
vi.mock('../plugins/hook-emitter',()=>({emitPluginHook:vi.fn()}));
vi.mock('../session/session-revival-service',()=>({SessionRevivalService:class{revive=ports.revive;}}));
vi.mock('../session/session-queue-service',()=>({getSessionQueueService:()=>({reassignQueue:vi.fn()})}));
vi.mock('./index',()=>({getAutomationStore:()=>ports.store,getAutomationRunner:()=>ports.runner}));
vi.mock('../session/session-admission-service',()=>({getSessionAdmissionService:()=>({registerRedeliveryHandler:vi.fn(),admitAutomatedWrite:()=>({kind:'admitted',admissionId:'receipt'}),markDelivered:vi.fn(),markFailed:vi.fn()})}));


const cases=(['thread','newInstance'] as const).flatMap(destination=>(['first-notification','before-engine','engine-settle','revival','provider'] as const).flatMap(pickupAt=>[false,true].map(finished=>({destination,pickupAt,finished,recorded:false}))));
cases.push({destination:'thread',pickupAt:'revival',finished:false,recorded:true});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
it.each(cases)('cancels recorded automation on manual target handoff: %j',async({destination,pickupAt,finished,recorded})=>{
  GlobalPauseService._resetForTesting();WorkAdmission._resetForTesting();resetAutomationEventsForTesting();
  const db=defaultDriverFactory(':memory:');createTables(db);createMigrationsTable(db);runMigrations(db);
  const store=new AutomationStore(db,{prepare:async()=>[],replacePrepared:()=>undefined,listForAutomation:async()=>[]} as never);
  const initialEntered=deferred(),resumeEntered=deferred(),releaseResume=deferred();
  const providerMessages:string[]=[];
  const chat={id:'chat',displayName:'Chat',workingDirectory:'/tmp',provider:'codex',status:'busy',parentId:null,metadata:{} as Record<string,unknown>,outputBuffer:[]};
  let threadStarted=false;
  const sendInput=vi.fn(async(_id:string,prompt:string,_attachments:unknown,options:InstanceSendInputOptions={})=>{
    if(destination==='thread'&&!threadStarted){
      threadStarted=true;options.beforeProviderDispatch?.();providerMessages.push(prompt);initialEntered.resolve();
      await new Promise<void>((_resolve,reject)=>options.signal?.addEventListener('abort',()=>reject(options.signal?.reason),{once:true}));
      return;
    }
    if(options.internalSource==='global-pause-resume'&&pickupAt==='provider'){resumeEntered.resolve();await releaseResume.promise;}
    options.signal?.throwIfAborted();options.beforeProviderDispatch?.();providerMessages.push(prompt);
    if(prompt==='James replacement task'&&finished){
      chat.status='idle';manager.emit('provider:normalized-event',{instanceId:'chat',event:{kind:'output',messageType:'assistant',content:'James unrelated task completed'}});
      manager.emit('provider:normalized-event',{instanceId:'chat',event:{kind:'complete'}});
    }
  });
  const createInstance=vi.fn(async(config:{initialPrompt:string;metadata:Record<string,unknown>})=>{chat.metadata=config.metadata;providerMessages.push(config.initialPrompt);initialEntered.resolve();return chat;});
  const terminateInstance=vi.fn();
  let waits=0;
  const waitForInstanceSettled=vi.fn(async(_id:string,options?:{signal?:AbortSignal})=>{
    if(pickupAt==='engine-settle'&&++waits===1){
      resumeEntered.resolve();await new Promise<void>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(options.signal?.reason),{once:true}));
    }
    return {...chat,status:'idle'};
  });
  const manager=Object.assign(new EventEmitter(),{sendInput,createInstance,terminateInstance,getAllInstances:()=>destination==='newInstance'||recorded?[chat]:[],getInstance:()=>chat,interruptInstance:vi.fn(),waitForInstanceSettled});
  let resuming=false,revivals=0;
  ports.revive.mockImplementation(async()=>{
    if(resuming&&pickupAt==='revival'){
      if(recorded&&++revivals===1)return {status:'failed'};
      resumeEntered.resolve();await releaseResume.promise;
    }
    return {status:'live',instanceId:'chat',restoreMode:'native-resume'};
  });
  const runner=new AutomationRunner(store,undefined,Date.now,undefined,undefined,undefined,undefined,()=>false,async(_run,_store,dispatch)=>dispatch());runner.initialize(manager as unknown as InstanceManager);ports.store=store;ports.runner=runner;
  const automation=await store.create({name:'Work',schedule:{type:'cron',expression:'0 * * * *',timezone:'UTC'},destination:destination==='thread'?{kind:'thread',instanceId:'chat',reviveIfArchived:true}:{kind:'newInstance'},action:{prompt:'Original request',workingDirectory:'/tmp'}},1000);
  const firing=runner.fire(automation.id,{trigger:'manual'});await initialEntered.promise;
  if(destination==='newInstance')await firing;
  const run=store.listActiveRuns()[0];
  const runtime=createGlobalPauseRuntime(manager as unknown as InstanceManager);runtime.level=()=>3;runtime.runningWork=undefined;runtime.engines=async()=>store.listActiveRuns().filter(run=>run.status==='running').map(run=>({kind:'automation-run',id:run.id,displayName:'Work'}));
  const service=GlobalPauseService.getInstance({store:new GlobalPauseStore(db),runtime});
  let terminalEvents=0;
  getAutomationEvents().on('automation:run-terminal',({runId}:{runId:string})=>{terminalEvents++;service.voidTarget(runId,'scheduled-job-ended');});
  let interruptsAtPickup=0;
  const pickUp=async()=>{interruptsAtPickup=manager.interruptInstance.mock.calls.length;service.manualInput('chat');await manager.sendInput('chat','James replacement task',undefined,{});};
  let initialPickup:Promise<void>|undefined;let notified=false;
  if(pickupAt==='first-notification')service.on('state-changed',state=>{if(state.phase==='collecting'&&!notified){notified=true;initialPickup=pickUp();}});
  if(pickupAt==='before-engine'){let picked=false;const original=runtime.pauseEngines;runtime.pauseEngines=async entries=>{if(!picked){picked=true;await pickUp();}await original(entries);};}
  const pausing=service.pauseForRestart({withNotes:false});
  if(pickupAt==='engine-settle'){await resumeEntered.promise;await pickUp();}
  await pausing;await firing;await initialPickup;
  resuming=true;const continuing=service.resume();
  if(pickupAt!=='before-engine'&&pickupAt!=='first-notification'&&pickupAt!=='engine-settle'){await resumeEntered.promise;await pickUp();releaseResume.resolve();}
  await continuing;
  expect(manager.interruptInstance).toHaveBeenCalledTimes(interruptsAtPickup);
  expect(providerMessages).toEqual(['Original request','James replacement task']);
  expect(store.getRun(run.id)?.status).toBe('cancelled');
  expect(terminateInstance).not.toHaveBeenCalled();expect(createInstance).toHaveBeenCalledTimes(destination==='newInstance'?1:0);
  expect(terminalEvents).toBe(1);expect(service.listenerCount('state-changed')).toBe(pickupAt==='first-notification'?1:0);
  if(destination==='newInstance'&&pickupAt==='before-engine'&&!finished){
    await service.pauseForRestart({withNotes:false});
    expect(service.getState().entries.find(entry=>entry.kind==='session'&&entry.targetId==='chat')).toMatchObject({wasBusy:true,state:'ready',noteKind:'basic'});
    expect(chat.metadata['automationRunId']).toBeUndefined();expect(chat.metadata['automationSourceRunId']).toBe(run.id);
  }
  GlobalPauseService._resetForTesting();WorkAdmission._resetForTesting();resetAutomationEventsForTesting();db.close();
});
