import {AutomationRunChangedEventSchema} from '../../../packages/contracts/src/schemas/automation.schemas';
import {TestBed} from '@angular/core/testing';
import {NgZone} from '@angular/core';
import {afterEach,expect,it,vi} from 'vitest';
import {AutomationStore} from '../../renderer/app/core/state/automation.store';
import {AutomationIpcService} from '../../renderer/app/core/services/ipc/automation-ipc.service';
import {ElectronIpcService} from '../../renderer/app/core/services/ipc/electron-ipc.service';

afterEach(()=>TestBed.resetTestingModule());
it.each(['late-delivery','duplicate','first-terminal','running-to-terminal','seen','aged-out','stale-seen'])('%s updates actual IPC consumer without recounting the same unread result',async mode=>{
 let onRun:(e:unknown)=>void=()=>{throw new Error('listener not installed');};
 const run={id:'run',automationId:'automation',status:mode==='running-to-terminal'?'running':'skipped',seenAt:(mode==='seen'||mode==='stale-seen')?123:null,threadPromptDelivered:false,trigger:'manual',scheduledAt:1,startedAt:1,finishedAt:2,instanceId:'target',loopRunId:null,error:null,outputSummary:null,outputFullRef:null,idempotencyKey:null,triggerSource:null,deliveryMode:'notify',createdAt:1,updatedAt:2,configSnapshot:null,attempt:1,maxAttempts:1};
 const api={automationList:async()=>({success:true,data:[{id:'automation',unreadRunCount:mode==='running-to-terminal'?0:1}]}),automationListRuns:async()=>({success:true,data:mode==='first-terminal'||mode==='aged-out'?[]:[run]}),onAutomationChanged:()=>()=>undefined,onAutomationRunChanged:(handler:(e:unknown)=>void)=>{onRun=handler;return()=>undefined;}};
 TestBed.configureTestingModule({providers:[AutomationStore,AutomationIpcService,{provide:ElectronIpcService,useFactory:()=>({getApi:()=>api,getNgZone:()=>TestBed.inject(NgZone)})}]});
 const store=TestBed.inject(AutomationStore);await store.refresh();
 onRun(AutomationRunChangedEventSchema.parse({automationId:'automation',...(mode==='late-delivery'||mode==='aged-out'?{updateKind:'delivery-evidence'}:{}),run:{...run,status:'skipped',seenAt:mode==='stale-seen'?null:run.seenAt,threadPromptDelivered:mode==='late-delivery'}}));
 expect(store.runs().find(r=>r.id==='run')?.threadPromptDelivered).toBe(mode==='aged-out'?undefined:mode==='late-delivery');if(mode==='stale-seen')expect(store.runs()[0].seenAt).toBe(123);
 expect(store.unreadCount()).toBe(mode==='first-terminal'?2:1);
});

import {ThreadWakeupRunner} from '../../main/automations/thread-wakeup-runner';
import {AutomationStore as BackendAutomationStore} from '../../main/automations/automation-store';
import {getAutomationEvents,resetAutomationEventsForTesting} from '../../main/automations/automation-events';
import {createSqliteWasmDatabase} from '../../main/db/sqlite-wasm-driver';
import {createTables,createMigrationsTable,runMigrations} from '../../main/persistence/rlm/rlm-schema';
import type {RedeliveryHandler} from '../../main/session/session-admission-service';
import type {InstanceSendInputOptions} from '../../main/instance/instance-input-cancellation';
import type {FileAttachment} from '../../shared/types/instance.types';
const admission=vi.hoisted(()=>({redelivery:(()=>{throw new Error('unregistered handler');}) as RedeliveryHandler}));
vi.mock('../../main/session/session-admission-service',()=>({getSessionAdmissionService:()=>({registerRedeliveryHandler:(_origin:string,handler:RedeliveryHandler)=>{admission.redelivery=handler;},admitAutomatedWrite:()=>({kind:'suppressed',reason:'not-ready',admissionId:'inert'}),markFailed:vi.fn(),markDelivered:vi.fn()})}));

it.each(['ambiguous','success','no-dispatch'])('actual producer %s refresh reaches the IPC consumer without another unread result',async mode=>{
 resetAutomationEventsForTesting();const db=createSqliteWasmDatabase(':memory:');createTables(db);createMigrationsTable(db);runMigrations(db);
 const backend=new BackendAutomationStore(db,{prepare:async()=>[],replacePrepared:()=>undefined,listForAutomation:async()=>[]} as unknown as ConstructorParameters<typeof BackendAutomationStore>[1]);
 try{
  const automation=await backend.create({name:'Thread fixture',schedule:{type:'cron',expression:'0 * * * *',timezone:'UTC'},destination:{kind:'thread',instanceId:'target',reviveIfArchived:false},action:{prompt:'Check fixture',workingDirectory:'/tmp'}},1000,100);
  const decision=backend.decideAndInsertRun(automation,'manual',1000,1000);if(decision.kind!=='started')throw new Error('expected fixture run');
  let resolve!:()=>void;let reject!:(error:Error)=>void;const pending=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
  const sendInput=vi.fn(async(_id:string,_message:string,_attachments?:FileAttachment[],options?:InstanceSendInputOptions)=>{if(mode!=='no-dispatch')options?.beforeProviderDispatch?.();await pending;if(mode==='success')options?.onProviderInputDelivered?.();});
  const producer=new ThreadWakeupRunner({sendInput,getInstance:()=>undefined,interruptInstance:vi.fn(()=>false),waitForInstanceSettled:vi.fn(async()=>undefined)},{revive:async()=>({status:'live',instanceId:'target'})} as unknown as ConstructorParameters<typeof ThreadWakeupRunner>[1],backend,()=>1001);
  await producer.fireThreadWakeup({run:decision.run,automation,destination:{kind:'thread',instanceId:'target',reviveIfArchived:false}});
  const bus=getAutomationEvents();const api={automationList:async()=>({success:true,data:await backend.list()}),automationListRuns:async()=>({success:true,data:backend.listRuns()}),onAutomationChanged:(callback:(e:unknown)=>void)=>{bus.on('automation:changed',callback);return()=>bus.off('automation:changed',callback);},onAutomationRunChanged:(callback:(e:unknown)=>void)=>{const listener=(event:unknown)=>callback(AutomationRunChangedEventSchema.parse(event));bus.on('automation:run-changed',listener);return()=>bus.off('automation:run-changed',listener);}};
  TestBed.configureTestingModule({providers:[AutomationStore,AutomationIpcService,{provide:ElectronIpcService,useFactory:()=>({getApi:()=>api,getNgZone:()=>TestBed.inject(NgZone)})}]});
  const view=TestBed.inject(AutomationStore);await view.refresh();expect(view.unreadCount()).toBe(1);expect(view.runs()[0].threadPromptDelivered).toBe(false);
  admission.redelivery({admissionId:'redelivery',instanceId:'target',message:'Check fixture',sourceMetadata:{runId:decision.run.id}});
  expect(view.runs()[0].threadPromptDelivered).toBeNull();expect(view.unreadCount()).toBe(1);
  if(mode==='ambiguous')reject(new Error('inert ambiguous write'));else resolve();
  if(mode!=='ambiguous')await vi.waitFor(()=>expect(view.runs()[0].threadPromptDelivered).toBe(mode==='success'));else {await Promise.resolve();await Promise.resolve();expect(view.runs()[0].threadPromptDelivered).toBeNull();}
  expect(view.unreadCount()).toBe(1);expect(view.runs()).toHaveLength(1);expect(view.runs()[0].status).toBe('skipped');
 }finally{TestBed.resetTestingModule();resetAutomationEventsForTesting();db.close();}
});
