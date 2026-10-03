import type { CliAdapter } from '../cli/adapters/adapter-factory';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import Database from 'better-sqlite3';
import type {SqliteDriver} from '../db/sqlite-driver';
import type {Instance} from '../../shared/types/instance.types';
import {CopilotCliAdapter} from '../cli/adapters/copilot-cli-adapter';
import {InstanceCommunicationManager} from '../instance/instance-communication';
import {ProviderRuntimeEventBus} from '../providers/provider-runtime-event-bus';
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
import {AntigravityCliAdapter} from '../cli/adapters/antigravity-cli-adapter';
import {CursorCliAdapter} from '../cli/adapters/cursor-cli-adapter';
import {OllamaCliAdapter} from '../cli/adapters/ollama-cli-adapter';
import {OpenAICompatibleChatAdapter} from '../cli/adapters/openai-compatible-chat-adapter';
const native=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('node:http',()=>({request:native.request}));
afterEach(()=>{vi.unstubAllGlobals();native.request.mockReset();});

describe('reachable ordinary provider failure delivery contract observation',()=>{
 it.each(['gemini','antigravity','copilot','ollama','openai','cursor'] as const)('rejects native failure instead of claiming delivered for %s',async name=>{
  const adapter=name==='gemini'?new GeminiCliAdapter({timeout:1000}):name==='antigravity'?new AntigravityCliAdapter({timeout:1000}):name==='copilot'?new CopilotCliAdapter({accountProfileId:'disposable-profile',timeout:1000}):name==='ollama'?new OllamaCliAdapter():name==='openai'?new OpenAICompatibleChatAdapter():new CursorCliAdapter({timeout:1000});
  Object.assign(adapter,{isSpawned:true});
  const instance={id:'ordinary-failure-'+name,parentId:null,launchMode:'orchestrated',provider:name==='openai'?'local':name,sessionId:adapter.getSessionId(),adapterGeneration:0,restartEpoch:0,status:'idle',requestCount:4,lastActivity:0,outputBuffer:[]} as unknown as Instance;
  let nativeInputs=0;
  (adapter as unknown as {spawnProcess:(args:string[])=>ChildProcess}).spawnProcess=(_args)=>{
    nativeInputs++;
    const child=new EventEmitter() as unknown as ChildProcess;
    child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
    Object.defineProperties(child,{pid:{value:424242},killed:{value:false},exitCode:{value:null,configurable:true}});
    queueMicrotask(()=>{Object.defineProperty(child,'exitCode',{value:1});child.emit('close',1,null);});return child;
  };
  native.request.mockImplementation(()=>Object.assign(new EventEmitter(),{setTimeout:vi.fn(),write:()=>{nativeInputs++;throw new Error('synthetic native HTTP body write failure');},end:vi.fn(),destroy:vi.fn()}));
  vi.stubGlobal('fetch',vi.fn(async()=>{nativeInputs++;throw new Error('synthetic native fetch rejection');}));
  const events=new EventEmitter();
  const bus=new ProviderRuntimeEventBus(envelope=>events.emit('provider:normalized-event',envelope));
  // The factory routes Copilot/Cursor through ACP. Bind their direct provider adapters
  // as native seams here; the real sendInput implementation is still exercised.
  const communicationAdapter = adapter as unknown as CliAdapter;
  const communication=new InstanceCommunicationManager({getInstance:()=>instance,getAdapter:()=>communicationAdapter,setAdapter:()=>undefined,deleteAdapter:()=>false,queueUpdate:()=>undefined,processOrchestrationOutput:()=>undefined,onInterruptedExit:async()=>undefined,ingestToRLM:()=>undefined,ingestToUnifiedMemory:()=>undefined,emitProviderRuntimeEvent:(instanceId,event,opts)=>bus.enqueue({instanceId,event,provider:'copilot',timestamp:Date.now(),sessionId:instance.sessionId,...opts})});
  communication.setupAdapterEvents(instance.id,communicationAdapter);
  const errors:unknown[]=[];adapter.on('error',error=>errors.push(error));
  const service=getSessionAdmissionService();const delivered=vi.spyOn(service,'markDelivered');const failed=vi.spyOn(service,'markFailed');
  const controller=new AbortController();let admissions=0;let rejected:unknown;
  try{await communication.sendInput(instance.id,'Synthetic ordinary native failure',undefined,undefined,{signal:controller.signal,beforeProviderDispatch:()=>admissions++});}catch(error){rejected=error;}
  const rows=SessionAdmissionStore.getInstance(db as unknown as SqliteDriver).list({instanceId:instance.id});
  bus.removeInstance(instance.id);await adapter.terminate(false);
  expect(nativeInputs).toBe(1);expect(admissions).toBe(1);expect(rows).toHaveLength(1);
  expect(rejected).toBeInstanceOf(Error);expect(delivered).not.toHaveBeenCalled();expect(failed).toHaveBeenCalledOnce();expect(rows[0].state).toBe('failed');
 });
});
