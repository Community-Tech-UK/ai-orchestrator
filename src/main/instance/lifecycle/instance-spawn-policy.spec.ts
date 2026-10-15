import { describe, expect, it } from 'vitest';
import { applyInstanceSpawnPolicy } from './instance-spawn-policy';
describe('machine session spawn policy',()=>{
  it('enforces Claude readonly reviews and pins replacements to the same queue task',()=>{
    const reviewer={depth:0,parentId:null,metadata:{pingPongReviewer:true},id:'review'};
    expect(applyInstanceSpawnPolicy('claude',reviewer,{yoloMode:true})).toMatchObject({readOnlyReview:true,yoloMode:false,maxTurns:8,sessionKind:'review',machineSession:'ping-pong-review'});
    const queue={depth:1,parentId:'parent',metadata:{planQueueRunId:'run',planQueueItemId:'item'},id:'worker'};
    expect(applyInstanceSpawnPolicy('codex',queue,{})).toMatchObject({sessionKind:'plan-queue',machineSession:'plan-queue',trialKey:'item'});
    expect(applyInstanceSpawnPolicy('codex',{...queue,id:'replacement'},{}).trialKey).toBe('item');
  });
  it('preserves explicit tags and durability for root Codex chats',()=>{
    expect(applyInstanceSpawnPolicy('codex',{depth:0,parentId:null,metadata:{},id:'chat'},{})).toMatchObject({ephemeral:false,sessionKind:'chat'});
    expect(applyInstanceSpawnPolicy('codex',undefined,{machineSession:'review',sessionKind:'review',trialKey:'caller'})).toMatchObject({machineSession:'review',sessionKind:'review',trialKey:'caller'});
  });
});
