import type { Instance } from '../../shared/types/instance.types';
import type { ChildProcess } from 'child_process';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { CodexCliAdapter } from '../cli/adapters/codex-cli-adapter';
import { InstanceContinuationRuntime } from './instance-continuation-runtime';
import { InstanceCommunicationManager } from './instance-communication';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
vi.mock('../cli/adapters/codex/app-server-client', async (importOriginal) => ({ ...await importOriginal<object>(), terminateProcessTree: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()}) }));

vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({triggerHooks:vi.fn(),triggerLifecycleHooks:vi.fn().mockResolvedValue({blocked:false})}) }));
const receipts=vi.hoisted(()=>({delivered:vi.fn(),failed:vi.fn()}));
vi.mock('../session/session-admission-service', () => ({getSessionAdmissionService:()=>({recordUserSend:()=>({admissionId:'disposable-admission'}),markDelivered:receipts.delivered,markFailed:receipts.failed})}));
vi.mock('../core/config/settings-manager', () => ({getSettingsManager:()=>({getAll:()=>({outputBufferSize:100,enableDiskStorage:false})})}));

vi.mock('../memory/output-storage',()=>({getOutputStorageManager:()=>({storeMessages:vi.fn(),deleteInstance:vi.fn()})}));


import { PassThrough } from 'node:stream';

describe('actual Codex exec continuation cancellation boundary', () => {
  it.each(['stop','manual-input','admission-stop','written-stop','success'] as const)('keeps native writes and receipts honest for %s', async (mode) => {
    receipts.delivered.mockClear();receipts.failed.mockClear();
    const adapter = new CodexCliAdapter({timeout:2000});
    Object.assign(adapter,{useAppServer:false,isSpawned:true});
    const instance={id:'root-exec',parentId:null,launchMode:'orchestrated',provider:'codex',sessionId:'exec-1',adapterGeneration:1,status:'idle',requestCount:3,lastActivity:0,outputBuffer:[]} as unknown as Instance;
    const events=new EventEmitter();
    const nativeWrites:string[]=[];
    let spawns=0;
    (adapter as unknown as {spawnProcess:()=>ChildProcess}).spawnProcess=()=>{
      spawns++;
      const child=new EventEmitter() as unknown as ChildProcess;
      const stdout=new PassThrough(); child.stdout=stdout; child.stderr=new PassThrough();
      child.stdin=new PassThrough(); child.stdin.on('data',(chunk:Buffer)=>nativeWrites.push(chunk.toString()));
      Object.defineProperties(child,{pid:{value:424242},killed:{value:false},exitCode:{value:null,configurable:true}});
      child.stdin.once('finish',()=>{
        stdout.write(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Finished.'}})+'\n');
        Object.defineProperty(child,'exitCode',{value:0}); child.emit('close',0,null);
      });
      return child;
    };
    const completed=vi.fn();adapter.on('complete',completed);
    adapter.on('status',(status)=>{instance.status=status;if(status==='busy'&&(mode==='stop'||mode==='manual-input'))queueMicrotask(()=>events.emit(mode==='stop'?'instance:interrupt-requested':'instance:input-started',{instanceId:'root-exec',autoContinuation:false}));});
    const communication=new InstanceCommunicationManager({getInstance:()=>instance,getAdapter:()=>adapter,setAdapter:()=>undefined,deleteAdapter:()=>false,queueUpdate:()=>undefined,processOrchestrationOutput:()=>undefined,onInterruptedExit:async()=>undefined,ingestToRLM:()=>undefined,ingestToUnifiedMemory:()=>undefined});
    let sent!:Promise<void>;
    let admitted=0;
    const runtime=new InstanceContinuationRuntime(new InstanceAsyncWorkRegistry(),{
      on:events.on.bind(events),off:events.off.bind(events),getInstance:()=>instance,getAdapter:()=>adapter,
      waitForInstanceSettled:async()=>instance,
      sendInput:async (_id,prompt,_attachments,opts)=>{
        sent=communication.sendInput('root-exec',prompt,undefined,undefined,{...opts,beforeProviderDispatch:()=>{
          opts?.beforeProviderDispatch?.(); admitted++; instance.requestCount++;
          if(mode==='admission-stop')events.emit('instance:interrupt-requested',{instanceId:'root-exec'});
          if(mode==='written-stop')queueMicrotask(()=>events.emit('instance:interrupt-requested',{instanceId:'root-exec'}));
        }});
        await sent;
      },
    });
    runtime.start();
    try {
      events.emit('provider:normalized-event',{instanceId:'root-exec',provider:'codex',event:{kind:'complete',requestCountAtCompletion:3,turnEnding:{reason:'max_output',evidence:'native_max_output'}}});
      await vi.waitFor(()=>expect(sent).toBeDefined());
      await sent;
      const written=mode==='success'||mode==='written-stop';
      expect(spawns).toBe(mode==='stop'||mode==='manual-input'?0:1);
      expect(nativeWrites).toHaveLength(written?1:0);
      expect(admitted).toBe(mode==='stop'||mode==='manual-input'?0:1);
      expect(receipts.delivered).toHaveBeenCalledTimes(mode==='success'?1:0);
      expect(receipts.failed).toHaveBeenCalledTimes(mode==='admission-stop'||mode==='written-stop'?1:0);
      expect(completed).toHaveBeenCalledTimes(mode==='success'?1:0);
    } finally {runtime.stop(); await adapter.terminate(false);}
  });
});
