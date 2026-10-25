import { EventEmitter } from 'events';
import { expect,it,vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance,InstanceCreateConfig } from '../../shared/types/instance.types';
import type { InstanceSendInputOptions } from '../instance/instance-input-cancellation';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createTables,createMigrationsTable,runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { getAutomationEvents,resetAutomationEventsForTesting } from './automation-events';
import { GlobalPauseService } from '../global-pause/global-pause-service';
import { GlobalPauseStore } from '../global-pause/global-pause-store';
import { createGlobalPauseRuntime } from '../global-pause/global-pause-runtime';
import { WorkAdmission } from '../work-admission/work-admission';

const ports=vi.hoisted(()=>({store:null as unknown,runner:null as unknown,history:{getEntries:vi.fn(),loadConversation:vi.fn(),markNativeResumeFailed:vi.fn()}}));
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/ai-orchestrator-test'},powerMonitor:new EventEmitter()}));
vi.mock('../plugins/hook-emitter',()=>({emitPluginHook:vi.fn()}));
vi.mock('./index',()=>({getAutomationStore:()=>ports.store,getAutomationRunner:()=>ports.runner}));
vi.mock('../history/history-manager',()=>({getHistoryManager:()=>ports.history}));
vi.mock('../core/config/settings-manager',()=>({getSettingsManager:()=>({getAll:()=>({sessionHandoffStateEnabled:false}),get:()=>3})}));
vi.mock('../memory/output-storage',()=>({getOutputStorageManager:()=>({storeMessages:vi.fn()})}));
vi.mock('../plan-queue/plan-queue-coordinator',()=>({getPlanQueueCoordinator:()=>({isInitialized:()=>false})}));
vi.mock('../orchestration/loop-coordinator',()=>({getLoopCoordinator:()=>({getActiveLoops:()=>[]})}));
vi.mock('../orchestration/campaign-coordinator',()=>({getCampaignCoordinator:()=>({listRunningCampaigns:()=>[]})}));
vi.mock('../repo-jobs/repo-job-service',()=>({getRepoJobService:()=>({getRunningJobsForGlobalPause:()=>[]})}));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

it.each(['creation','provider'] as const)('maps a real History revival to its recorded automation without replacing the run ID: %s',async pickupAt=>{
  GlobalPauseService._resetForTesting();WorkAdmission._resetForTesting();resetAutomationEventsForTesting();
  const db=defaultDriverFactory(':memory:');createTables(db);createMigrationsTable(db);runMigrations(db);
  const store=new AutomationStore(db,{prepare:async()=>[],replacePrepared:()=>undefined,listForAutomation:async()=>[]} as never);
  const instances=new Map<string,Instance>();const published=deferred(),releaseCreation=deferred(),providerEntered=deferred(),releaseProvider=deferred();
  const providerMessages:string[]=[];let restoredId='';
  const createInstance=vi.fn(async(config:InstanceCreateConfig)=>{
    const id=config.isRestoredSession?'revived-chat':'original-chat';
    const instance={...config,id,status:config.isRestoredSession?'idle':'busy',outputBuffer:[...(config.initialOutputBuffer??[])],
      historyThreadId:config.historyThreadId??'saved-history',providerSessionId:config.isRestoredSession?undefined:'saved-provider'} as unknown as Instance;
    instances.set(id,instance);
    if(config.isRestoredSession){restoredId=id;published.resolve();if(pickupAt==='creation')await releaseCreation.promise;}
    else providerMessages.push(config.initialPrompt??'');
    return instance;
  });
  const sendInput=vi.fn(async(_id:string,prompt:string,_attachments:unknown,options:InstanceSendInputOptions={})=>{
    if(options.internalSource==='global-pause-resume'){providerEntered.resolve();await releaseProvider.promise;}
    options.signal?.throwIfAborted();options.beforeProviderDispatch?.();providerMessages.push(prompt);
    const live=instances.get(_id);if(live)live.status='busy';
  });
  const terminateInstance=vi.fn();
  const manager=Object.assign(new EventEmitter(),{createInstance,sendInput,terminateInstance,getAllInstances:()=>[...instances.values()],getInstance:(id:string)=>instances.get(id),
    interruptInstance:vi.fn(),waitForInstanceSettled:async(id:string)=>({...instances.get(id),status:'idle'}),queueContinuityPreamble:vi.fn()});
  const runner=new AutomationRunner(store,undefined,Date.now,undefined,undefined,undefined,undefined,()=>false,async(_run,_store,dispatch)=>dispatch());
  runner.initialize(manager as unknown as InstanceManager);ports.store=store;ports.runner=runner;
  const automation=await store.create({name:'Original automation',schedule:{type:'cron',expression:'0 * * * *',timezone:'UTC'},action:{prompt:'Original request',workingDirectory:'/tmp'}},1000);
  await runner.fire(automation.id,{trigger:'manual'});const run=store.listActiveRuns()[0];
  const runtime=createGlobalPauseRuntime(manager as unknown as InstanceManager);runtime.runningWork=undefined;
  const pauseStore=new GlobalPauseStore(db);const service=GlobalPauseService.getInstance({store:pauseStore,runtime});
  getAutomationEvents().on('automation:run-terminal',({runId}:{runId:string})=>service.voidTarget(runId,'scheduled-job-ended'));
  await service.pauseForRestart({withNotes:false});const batch=service.getState().batchId!;
  expect(pauseStore.entries(batch).find(entry=>entry.kind==='automation-run')).toMatchObject({targetId:run.id,originalInstanceId:'original-chat',historyThreadId:'saved-history'});
  instances.delete('original-chat');
  const archived={id:'archive',originalInstanceId:'original-chat',historyThreadId:'saved-history',sessionId:'',provider:'claude',displayName:'Restored work',workingDirectory:'/tmp'};
  ports.history.getEntries.mockReturnValue([archived]);ports.history.loadConversation.mockResolvedValue({entry:archived,messages:[{id:'saved-user',type:'user',content:'Original request',timestamp:1}]});
  const continuing=service.resume();await published.promise;
  if(pickupAt==='provider')await providerEntered.promise;
  expect(restoredId).not.toBe('original-chat');expect(instances.get(restoredId)?.metadata?.['automationRunId']).toBeUndefined();
  const unrelated=await store.create({name:'Unrecorded automation',schedule:{type:'cron',expression:'0 * * * *',timezone:'UTC'},action:{prompt:'Different work',workingDirectory:'/tmp'}},2000);
  const decision=store.decideAndInsertRun(unrelated,'manual',2000);if(decision.kind!=='started')throw new Error('Fixture did not start unrelated run');
  store.attachInstance(decision.run.id,restoredId);
  service.manualInput(restoredId);await manager.sendInput(restoredId,'James replacement task',undefined,{});
  releaseCreation.resolve();releaseProvider.resolve();await continuing;
  await vi.waitFor(()=>expect(manager.queueContinuityPreamble).toHaveBeenCalled());
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(providerMessages).toEqual(['Original request','James replacement task']);
  expect(store.getRun(run.id)?.status).toBe('cancelled');expect(store.getRun(decision.run.id)?.status).toBe('running');
  expect(pauseStore.entries(batch).find(entry=>entry.kind==='automation-run')?.targetId).toBe(run.id);
  expect(instances.get(restoredId)?.status).toBe('busy');expect(terminateInstance).not.toHaveBeenCalled();
  expect(service.listenerCount('state-changed')).toBe(0);
  GlobalPauseService._resetForTesting();WorkAdmission._resetForTesting();resetAutomationEventsForTesting();db.close();
});
