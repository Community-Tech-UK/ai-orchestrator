import { EventEmitter } from 'events';
import { expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { pauseConsults } from '../work-admission/consult-admission';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { createGlobalPauseRuntime } from '../global-pause/global-pause-runtime';
import { GlobalPauseService } from '../global-pause/global-pause-service';
import { GlobalPauseStore } from '../global-pause/global-pause-store';
import { markAutomaticStartupInputDispatched } from '../work-admission/automatic-startup';
import { deliverInitialPromptAfterSpawn } from '../instance/lifecycle/initial-prompt-recovery';
const ports = vi.hoisted(() => ({store: null as unknown, runner: null as unknown, resumeLoop: vi.fn(), revive: vi.fn()}));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ai-orchestrator-test' }, powerMonitor: new EventEmitter() }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
// The account rules read settings; their own spec covers them.
vi.mock('./automation-account-rules', () => ({ automationAccountPreferences: async () => undefined }));
vi.mock('../orchestration/loop-resume', () => ({resumeLoopRun: ports.resumeLoop}));
vi.mock('../session/session-revival-service',()=>({SessionRevivalService:class{revive=ports.revive;}}));
vi.mock('./index', () => ({getAutomationStore: () => ports.store, getAutomationRunner: () => ports.runner}));

it.each(['first', 'retry'] as const)('restart pause waits for admitted %s dispatch and resumes its original prompt once', async dispatchKind => {
  WorkAdmission._resetForTesting();
  const db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
  const store = new AutomationStore(db, {prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => []} as never);
  const instances: unknown[] = [];
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => {entered=resolve;}); const gate = new Promise<void>(resolve => {release=resolve;});
  const createInstance = vi.fn(async (config: object) => { entered(); await gate; const instance = { ...config, id: 'late-automation', status: 'busy', outputBuffer: [] }; instances.push(instance); return instance; });
  const terminateInstance = vi.fn(async () => { instances.splice(0); });
  const manager = Object.assign(new EventEmitter(), {createInstance, terminateInstance, getAllInstances: () => instances,
    getInstance: () => instances[0], interruptInstance: vi.fn(), waitForInstanceSettled: vi.fn()});
  const runner = new AutomationRunner(store, undefined, Date.now, undefined, undefined, undefined, undefined, () => false, async (_run, _store, dispatch) => dispatch());
  runner.initialize(manager as unknown as InstanceManager); ports.store=store; ports.runner=runner;
  const automation = await store.create({name: 'Work', schedule: {type: 'cron', expression: '0 * * * *', timezone: 'UTC'}, action: {prompt: 'Implement export',workingDirectory: '/tmp'}}, 1000);
  const decision = dispatchKind === 'retry' ? store.decideAndInsertRun(automation,'manual',1000) : null;
  if (decision && decision.kind !== 'started') throw Error('fixture');
  const dispatching = decision?.kind === 'started' ? runner.dispatchRetryRun(decision.run) : runner.fire(automation.id, {trigger:'manual'});
  await started;
  const run = store.listActiveRuns()[0];
  const runtime = createGlobalPauseRuntime(manager as unknown as InstanceManager); runtime.level=()=>3; runtime.runningWork=undefined;
  runtime.engines=async()=>[{kind:'automation-run',id:run.id,displayName:'Work'}];
  const service=new GlobalPauseService({store:new GlobalPauseStore(db),runtime});
  let safe=false; const pausing=service.pauseForRestart({withNotes:false}).then(()=>{safe=true;});
  await new Promise<void>(resolve=>setImmediate(resolve)); const safeBeforeCreation=safe;
  release(); await dispatching; await pausing;
  expect({safeBeforeCreation,phase:service.getState().phase,liveInstances:instances.length,terminated:terminateInstance.mock.calls.length,attached:store.getRun(run.id)?.instanceId}).toEqual({safeBeforeCreation:false,phase:'ready',liveInstances:0,terminated:1,attached:null});
  expect(store.getRun(run.id)?.status).toBe('running');
  await Promise.all([service.resume(), runner.resumePendingRunForGlobalPause(run.id)]);
  expect(createInstance).toHaveBeenCalledTimes(2);
  expect(createInstance.mock.calls[1][0]).toMatchObject({initialPrompt:'Implement export'});
  expect(store.getRun(run.id)?.instanceId).toBe('late-automation');
  expect(store.listActiveRuns()).toHaveLength(1);
  service.shutdown(); WorkAdmission._resetForTesting(); db.close();
});

it('keeps an attached automation running when restart cancels its background initial prompt', async () => {
  WorkAdmission._resetForTesting();
  const db=defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
  const store=new AutomationStore(db,{prepare:async()=>[],replacePrepared:()=>undefined,listForAutomation:async()=>[]} as never);
  let failReady!: (error: Error) => void;
  const readyPromise=new Promise<void>((_resolve,reject)=>{failReady=reject;});
  const instance={id:'initializing-automation',status:'initializing',outputBuffer:[],readyPromise};
  const manager=Object.assign(new EventEmitter(),{createInstance:vi.fn(async()=>instance),terminateInstance:vi.fn(async()=>undefined)});
  const runner=new AutomationRunner(store,undefined,Date.now,undefined,undefined,undefined,undefined,()=>false,async(_run,_store,dispatch)=>dispatch());
  runner.initialize(manager as unknown as InstanceManager);
  const automation=await store.create({name:'Work',schedule:{type:'cron',expression:'0 * * * *',timezone:'UTC'},action:{prompt:'Original request',workingDirectory:'/tmp'}},1000);
  await runner.fire(automation.id,{trigger:'manual'});
  const run=store.listActiveRuns()[0];
  getWorkAdmission().setGlobalPhase('collecting');
  failReady(new Error('Automatic startup cancelled for restart'));
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(store.getRun(run.id)).toMatchObject({status:'running',instanceId:instance.id,error:null});
  await pauseConsults();
  WorkAdmission._resetForTesting(); db.close();
});

it('resumes and retracks a late attached loop through its recorded automation entry', async () => {
  const trackLoopRunForGlobalPause=vi.fn();
  ports.store={getRun:()=>({id:'run',status:'running',instanceId:null,loopRunId:'late-loop'})};
  ports.runner={trackLoopRunForGlobalPause};
  ports.resumeLoop.mockResolvedValue({ok:true});
  const runtime=createGlobalPauseRuntime({getAllInstances:()=>[]} as unknown as InstanceManager);
  await runtime.resumeEngine({kind:'automation-run',targetId:'run'} as never);
  expect(ports.resumeLoop).toHaveBeenCalledWith(expect.anything(),expect.anything(),'late-loop');
  expect(trackLoopRunForGlobalPause).toHaveBeenCalledWith('run','late-loop');
  expect(trackLoopRunForGlobalPause.mock.invocationCallOrder[0]).toBeLessThan(ports.resumeLoop.mock.invocationCallOrder[0]);
});

it.each([false,true])('resumes an attached automation exactly once, original prompt already delivered: %s', async delivered => {
 WorkAdmission._resetForTesting();
 const db=defaultDriverFactory(':memory:');createTables(db);createMigrationsTable(db);runMigrations(db);
 const attachments=[{name:'brief.txt',type:'text/plain',size:18,data:'attachment fixture'}];
 const store=new AutomationStore(db,{prepare:async()=>[],replacePrepared:()=>undefined,listForAutomation:async()=>attachments} as never);
 let release!:()=>void;const starting=new Promise<void>(resolve=>{release=resolve;});const originalSend=vi.fn(async(_prompt:string,_attachments?:unknown[])=>undefined);
 const instances: object[]=[];
 const createInstance=vi.fn(async(config:{initialPrompt?:string;attachments?:unknown[]})=>{
   const instance={...config,id:'starting',status:'initializing',outputBuffer:[],abortController:new AbortController(),readyPromise:undefined as Promise<void>|undefined};
   instance.readyPromise=(async()=>{await starting;if(instance.abortController.signal.aborted)return;await deliverInitialPromptAfterSpawn(instance as never,instance.abortController.signal,async()=>{markAutomaticStartupInputDispatched(instance.id);await originalSend(config.initialPrompt??'',config.attachments);},{} as never);instance.status='busy';})();
   instance.readyPromise.catch(()=>{instance.status='error';});instances.push(instance);return instance;
 });
 const sendInput=vi.fn(async()=>undefined);
 const terminateInstance=vi.fn(async()=>{(instances[0] as {abortController:AbortController})?.abortController.abort();release();instances.splice(0);});
 const manager=Object.assign(new EventEmitter(),{createInstance,getAllInstances:()=>instances,getInstance:()=>instances[0],sendInput,terminateInstance,interruptInstance:vi.fn(),waitForInstanceSettled:async()=>{await (instances[0] as {readyPromise:Promise<void>}).readyPromise.catch(()=>undefined);return instances[0];}});
 const runner=new AutomationRunner(store,undefined,Date.now,undefined,undefined,undefined,undefined,()=>false,async(_run,_store,dispatch)=>dispatch());runner.initialize(manager as never);ports.store=store;ports.runner=runner;
 const automation=await store.create({name:'Work',schedule:{type:'cron',expression:'0 * * * *',timezone:'UTC'},action:{prompt:'Original request',workingDirectory:'/tmp'}},1000);
 await runner.fire(automation.id,{trigger:'manual'});const run=store.listActiveRuns()[0];
 const runtime=createGlobalPauseRuntime(manager as never);runtime.level=()=>3;runtime.runningWork=undefined;runtime.sessions=()=>[];runtime.engines=async()=>[{kind:'automation-run',id:run.id,displayName:'Work'}];
 if(delivered){release();await (instances[0] as {readyPromise:Promise<void>}).readyPromise;}
 const service=new GlobalPauseService({store:new GlobalPauseStore(db),runtime});const pausing=service.pauseForRestart({withNotes:false});await pausing;
 expect(service.getState().phase).toBe('ready');expect(originalSend).toHaveBeenCalledTimes(delivered?1:0);
 ports.revive.mockResolvedValue({status:'revived',instanceId:'restored',restoreMode:'native-resume'});
 await service.resume();
 const observed={creations:createInstance.mock.calls.length,originalSends:originalSend.mock.calls.length,continuationCalls:sendInput.mock.calls};
 service.shutdown();WorkAdmission._resetForTesting();db.close();
 expect(originalSend).toHaveBeenCalledWith('Original request',attachments);
 expect(observed).toMatchObject(delivered?{creations:1,originalSends:1,continuationCalls:[['restored',expect.stringContaining('<saved-automation-request>\nOriginal request'),undefined,{internalSource:'global-pause-resume'}]]}:{creations:2,originalSends:1,continuationCalls:[]});
});
