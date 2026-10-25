import { EventEmitter } from 'events';
import { expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import type { InstanceSendInputOptions } from '../instance/instance-input-cancellation';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { pauseConsults } from '../work-admission/consult-admission';
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

it.each([
  {dispatched:false,recorded:false,pickup:false,stopFails:false,closed:false,manualFinished:false,duringResume:false},
  {dispatched:true,recorded:false,pickup:false,stopFails:false,closed:false,manualFinished:false,duringResume:false},
  {dispatched:true,recorded:true,pickup:false,stopFails:false,closed:false,manualFinished:false,duringResume:false},
  {dispatched:true,recorded:true,pickup:true,stopFails:false,closed:false,manualFinished:false,duringResume:false},
  {dispatched:true,recorded:true,pickup:false,stopFails:true,closed:false,manualFinished:false,duringResume:false},
  {dispatched:true,recorded:true,pickup:false,stopFails:false,closed:true,manualFinished:false,duringResume:false},
  {dispatched:true,recorded:true,pickup:true,stopFails:false,closed:false,manualFinished:true,duringResume:false},
  {dispatched:true,recorded:true,pickup:false,stopFails:false,closed:false,manualFinished:false,duringResume:true},
])('resumes thread wakeup once across the provider boundary: %j',async({dispatched,recorded,pickup,stopFails,closed,manualFinished,duringResume})=>{
  GlobalPauseService._resetForTesting(); WorkAdmission._resetForTesting(); resetAutomationEventsForTesting();
  const db=defaultDriverFactory(':memory:');createTables(db);createMigrationsTable(db);runMigrations(db);
  const store=new AutomationStore(db,{prepare:async()=>[],replacePrepared:()=>undefined,listForAutomation:async()=>[]} as never);
  let entered!:()=>void;const sending=new Promise<void>(resolve=>{entered=resolve;});
  const providerMessages:string[]=[];
  const chat={id:'chat',displayName:'Chat',workingDirectory:'/tmp',provider:'codex',status:'busy',parentId:null,outputBuffer:[{type:'assistant',content:'Old pause note',timestamp:1}] as {type:string;content:string;timestamp:number}[]};
  let calls=0; let takeoverTriggered=false;
  const sendInput=vi.fn(async(_id:string,prompt:string,_attachments:unknown,options:InstanceSendInputOptions={})=>{
    calls++;
    if(calls===1){
      if(dispatched){options.beforeProviderDispatch?.();providerMessages.push(prompt);}
      entered();await new Promise<void>((_resolve,reject)=>options.signal?.addEventListener('abort',()=>reject(options.signal?.reason),{once:true}));
    }else{
      if(duringResume&&!takeoverTriggered&&prompt!=='James picked up during Resume'){
        takeoverTriggered=true;service.manualInput('chat');
        await manager.sendInput('chat','James picked up during Resume',undefined,{});
      }
      options.signal?.throwIfAborted();
      options.beforeProviderDispatch?.();providerMessages.push(prompt);
      manager.emit('provider:normalized-event',{instanceId:'chat',event:{kind:'output',messageType:'assistant',content:'Completed original work'}});
      manager.emit('provider:normalized-event',{instanceId:'chat',event:{kind:'complete'}});
    }
  });
  const terminateInstance=vi.fn();
  let stopFailed=false;
  const waitForInstanceSettled=vi.fn(async()=>{if(stopFails&&!stopFailed){stopFailed=true;throw new Error('Thread turn is still stopping');}return {...chat,status:'idle'};});
  const manager=Object.assign(new EventEmitter(),{sendInput,terminateInstance,getAllInstances:()=>recorded?[chat]:[],getInstance:()=>chat,interruptInstance:vi.fn(),waitForInstanceSettled});
  ports.revive.mockResolvedValue({status:'live',instanceId:'chat',restoreMode:'native-resume'});
  const runner=new AutomationRunner(store,undefined,Date.now,undefined,undefined,undefined,undefined,()=>false,async(_run,_store,dispatch)=>dispatch());runner.initialize(manager as unknown as InstanceManager);ports.store=store;ports.runner=runner;
  const automation=await store.create({name:'Wake',schedule:{type:'cron',expression:'0 * * * *',timezone:'UTC'},destination:{kind:'thread',instanceId:'chat',reviveIfArchived:true},action:{prompt:'Original wakeup',workingDirectory:'/tmp'}},1000);
  const firing=runner.fire(automation.id,{trigger:'manual'});await sending;const run=store.listActiveRuns()[0];
  const runtime=createGlobalPauseRuntime(manager as unknown as InstanceManager);runtime.level=()=>3;runtime.runningWork=undefined;runtime.engines=async()=>[{kind:'automation-run',id:run.id,displayName:'Wake'}];
  const service=GlobalPauseService.getInstance({store:new GlobalPauseStore(db),runtime});
  let terminalEvents=0;
  getAutomationEvents().on('automation:run-terminal',({runId}:{runId:string})=>{terminalEvents++;service.voidTarget(runId,'scheduled-job-ended');});
  const pausing=service.pauseForRestart({withNotes:false});
  if(stopFails){
    await vi.waitFor(()=>expect(stopFailed).toBe(true));
    expect(service.getState().phase).toBe('collecting');
    await pauseConsults();
  }
  await pausing;await firing;
  const afterPause=store.getRun(run.id);
  expect(afterPause?.instanceId).toBe(dispatched?'chat':null);
  if(pickup){
    service.manualInput('chat');await manager.sendInput('chat','James picked up the chat',undefined,{});
    if(manualFinished){chat.status='idle';chat.outputBuffer.push({type:'assistant',content:'Manual continuation completed',timestamp:Date.now()});}
  }
  if(closed) service.voidTarget('chat','session-closed');
  await service.resume();
  if(duringResume) expect(providerMessages).toEqual(['Original wakeup','James picked up during Resume']);
  else if(closed) expect(providerMessages).toEqual(['Original wakeup']);
  else if(pickup){
    expect(providerMessages).toEqual(['Original wakeup','James picked up the chat']);

  }else if(dispatched){
    expect(providerMessages).toHaveLength(2);
    expect(providerMessages[1]).toContain('<saved-automation-request>\nOriginal wakeup');
  }else expect(providerMessages).toEqual(['Original wakeup']);
  expect(store.getRun(run.id)?.status).toBe(closed||pickup||duringResume?'cancelled':'succeeded');
  expect(providerMessages.filter(message=>message==='Original wakeup')).toHaveLength(1);
  expect(terminateInstance).not.toHaveBeenCalled();
  runner.cancelRunForGlobalPause(run.id,'Repeated ownership notification');
  expect(terminalEvents).toBe(1);
  GlobalPauseService._resetForTesting();WorkAdmission._resetForTesting();resetAutomationEventsForTesting();db.close();
});
