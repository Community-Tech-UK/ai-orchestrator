import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {InstanceChildCompletionHandler} from './instance-child-completion-handler';
import {OrchestrationHandler} from '../orchestration/orchestration-handler';
import {ChildResultStorage} from '../orchestration/child-result-storage';
import {createInstance, type Instance} from '../../shared/types/instance.types';
vi.mock('../rlm/llm-service',()=>({LLMService:{getInstance:()=>({countTokens:(s:string)=>s.length})}}));
vi.mock('../plugins/hook-emitter',()=>({emitPluginHook:vi.fn()}));
vi.mock('../core/config/settings-manager',()=>({getSettingsManager:()=>({get:()=>undefined,getAll:()=>({})})}));
vi.mock('../session/artifact-attribution-store',()=>({getArtifactAttributionStore:()=>({registerArtifact:vi.fn()})}));
vi.mock('../session/session-admission-service',()=>({getSessionAdmissionService:()=>({registerRedeliveryHandler:vi.fn(),admitAutomatedWrite:()=>({kind:'admitted',admissionId:'inert'}),markDelivered:vi.fn(),markFailed:vi.fn()})}));

afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();ChildResultStorage._resetForTesting();});
it.each([false,true,'synthesis-await'])('actual cached diagnostics preserve a new pending spawn wave; overlapping=%s',async overlapping=>{
 const dir=mkdtempSync(join(tmpdir(),'aio-batch-cache-race-'));ChildResultStorage._resetForTesting();const storage=ChildResultStorage.getInstance({storagePath:dir});await storage.initialize();
 const make=(id:string,parentId:string|null):Instance=>({...createInstance({workingDirectory:'/tmp',provider:'claude'}),id,parentId,displayName:id,status:'idle',createdAt:100,lastActivity:100,outputBuffer:[{id:id+'-out',timestamp:100,type:'assistant',content:'Result '+id}]});
 const parent=make('parent',null);const children=['a','b','c'].map(id=>make(id,'parent'));const instances=new Map([parent,...children].map(i=>[i.id,i]));
 for(const child of children)await storage.storeFromOutputBuffer(child.id,'parent','Fixture task','Result '+child.id,child.id!=='a',child.outputBuffer,100);
 expect(children.every(child=>storage.hasResult(child.id))).toBe(true);
 const orchestration=new OrchestrationHandler();orchestration.registerInstance('parent','/tmp');orchestration.on('inject-response',(_id,_response,confirm)=>confirm());
 const delivered=vi.spyOn(orchestration,'deliverChildCompleted');const synthesis=vi.spyOn(orchestration,'notifyAllChildrenCompleted');
 const handler=new InstanceChildCompletionHandler({getInstance:id=>instances.get(id),addToOutputBuffer:(i,m)=>i.outputBuffer.push(m),publishOutput:()=>{},terminateInstance:async id=>{instances.delete(id);orchestration.unregisterInstance(id);},getOrchestrationHandler:()=>orchestration,storage,taskManager:{getTaskByChildId:()=>null,cleanupChildTasks:()=>{}}});
 try{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(1000);orchestration.notifyChildSpawned('parent','a','A');
  let finishSpawn!:()=>void;const pendingSpawn=new Promise<void>(resolve=>{finishSpawn=resolve;}).then(()=>{vi.setSystemTime(40000);orchestration.notifyChildSpawned('parent','b','B');orchestration.notifyChildSpawned('parent','c','C');});
  const original=orchestration.notifyChildTerminated.bind(orchestration);const bookkeeping=vi.spyOn(orchestration,'notifyChildTerminated').mockImplementation((...args)=>{const result=original(...args);if(overlapping===true&&args[1]==='a'){expect(result.remainingChildren).toBe(0);finishSpawn();}return result;});
  const getCompleted=orchestration.getCompletedChildIds.bind(orchestration);vi.spyOn(orchestration,'getCompletedChildIds').mockImplementation(id=>{const ids=getCompleted(id);if(overlapping==='synthesis-await')finishSpawn();return ids;});
  await handler.handleChildExit('a',children[0],1);if(overlapping===false)finishSpawn();await pendingSpawn;
  expect(bookkeeping).toHaveBeenCalledTimes(1);expect(orchestration.hasActiveWork('parent')).toBe(true);
  if(overlapping==='synthesis-await')expect(synthesis.mock.calls[0][2]).toEqual({othersStillRunning:true});
  const callsBeforeB=delivered.mock.calls.length;const synthesesBeforeB=synthesis.mock.calls.length;
  await handler.handleChildExit('b',children[1],0);expect.soft(delivered.mock.calls.length).toBe(callsBeforeB);expect.soft(synthesis.mock.calls.length).toBe(synthesesBeforeB);
  await handler.handleChildExit('c',children[2],0);expect(synthesis.mock.calls.at(-1)?.[1].map(s=>s.childId)).toEqual(['b','c']);expect(bookkeeping).toHaveBeenCalledTimes(3);
  expect(Reflect.get(Reflect.get(handler,'batcher'),'parents').get('parent').holdTimer).toBeNull();
 }finally{handler.dispose();rmSync(dir,{recursive:true,force:true});}
});
