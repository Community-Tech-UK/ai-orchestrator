import { afterEach, describe, expect, it } from 'vitest';
import { applyInstanceSpawnPolicy } from './instance-spawn-policy';
import { _setOutputCapSettingsReaderForTesting } from '../../cli/adapters/claude-output-caps';
import { resolveTrialArm } from '../../cli/adapters/codex/codex-thread-policy';
describe('machine session spawn policy',()=>{
  it('keeps explicit semantic identity separate from experiment grouping', () => {
    const instance = { id: 'instance-placeholder', depth: 1, parentId: 'parent-placeholder', metadata: { planQueueRunId: 'run-placeholder', planQueueItemId: 'item-placeholder' } };
    expect(applyInstanceSpawnPolicy('codex', instance, { jobId: 'explicit-job-placeholder', instanceId: 'explicit-instance-placeholder', trialKey: 'GROUPING_ONLY_DO_NOT_LOG' }))
      .toMatchObject({ jobId: 'explicit-job-placeholder', instanceId: 'explicit-instance-placeholder', trialKey: 'GROUPING_ONLY_DO_NOT_LOG', sessionKind: 'plan-queue' });
  });
  it.each([
    { id: 'chat-placeholder', depth: 0, parentId: null, metadata: {} },
    { id: 'child-placeholder', depth: 1, parentId: 'parent-placeholder', metadata: {} },
    { id: 'reviewer-placeholder', depth: 0, parentId: null, metadata: { pingPongReviewer: true } },
    { id: 'automation-placeholder', depth: 0, parentId: null, metadata: { automationId: 'definition-placeholder' } },
  ])('never substitutes a parent, instance or automation definition for an unknown job: $id', instance => {
    const options = applyInstanceSpawnPolicy('codex', instance, { trialKey: 'GROUPING_ONLY_DO_NOT_LOG' });
    expect(options.jobId).toBeUndefined();
    expect(options.instanceId).toBe(instance.id);
  });
  it('uses the queue run when no individual queue item exists', () => {
    expect(applyInstanceSpawnPolicy('codex', { id: 'coordinator-placeholder', depth: 0, parentId: null, metadata: { planQueueRunId: 'run-placeholder', planQueueRole: 'coordinator' } }, {}))
      .toMatchObject({ jobId: 'run-placeholder', sessionKind: 'plan-queue' });
  });
  afterEach(() => _setOutputCapSettingsReaderForTesting(null));
  it.each([{}, { resume: true }, { forkSession: true, resume: true }])('binds every tracked OpenCode spawn to its main-instance checkpoint (%j)', (settings) => {
    const instance = { id: 'main-placeholder', depth: 0, parentId: null, metadata: {} };
    const options = applyInstanceSpawnPolicy('opencode', instance, { ...settings, sessionId: 'transport-placeholder' });
    expect(options.beforeProviderPrompt).toBeTypeOf('function');
    expect(applyInstanceSpawnPolicy('claude', instance, {}).beforeProviderPrompt).toBeUndefined();
    expect(applyInstanceSpawnPolicy('opencode', undefined, {}).beforeProviderPrompt).toBeUndefined();
  });
  it('carries stored OpenCode folders into every replacement and refuses another provider', () => {
    const instance = { depth: 0, parentId: null, metadata: {}, additionalDirectories: ['/repo/shared', 'C:\\shared'] };
    const options = applyInstanceSpawnPolicy('opencode', instance, { resume: true });
    expect(options.additionalDirectories).toEqual(instance.additionalDirectories);
    expect(options.additionalDirectories).not.toBe(instance.additionalDirectories);
    expect(() => applyInstanceSpawnPolicy('claude', instance, {})).toThrow(/OpenCode/);
  });
  it('enforces Claude readonly reviews and pins replacements to the same queue task',()=>{
    const reviewer={depth:0,parentId:null,metadata:{pingPongReviewer:true},id:'review'};
    expect(applyInstanceSpawnPolicy('claude',reviewer,{yoloMode:true})).toMatchObject({readOnlyReview:true,yoloMode:false,maxTurns:8,sessionKind:'review',machineSession:'ping-pong-review'});
    const queue={depth:1,parentId:'parent',metadata:{planQueueRunId:'run',planQueueItemId:'item'},id:'worker'};
    expect(applyInstanceSpawnPolicy('codex',queue,{})).toMatchObject({sessionKind:'plan-queue',machineSession:'plan-queue',trialKey:'item'});
    expect(applyInstanceSpawnPolicy('codex',{...queue,id:'replacement'},{}).trialKey).toBe('item');
  });
  it('carries the plan-queue role so a checker can be told from a worker, and keeps a caller role',()=>{
    const verifier={depth:1,parentId:'parent',metadata:{planQueueRunId:'run',planQueueItemId:'item',planQueueRole:'verifier'},id:'verifier'};
    expect(applyInstanceSpawnPolicy('codex',verifier,{})).toMatchObject({sessionKind:'plan-queue',trialKey:'item',queueRole:'verifier'});
    expect(applyInstanceSpawnPolicy('codex',{...verifier,metadata:{...verifier.metadata,planQueueRole:7}},{}).queueRole).toBeUndefined();
    expect(applyInstanceSpawnPolicy('codex',verifier,{queueRole:'caller'}).queueRole).toBe('caller');
    expect(applyInstanceSpawnPolicy('codex',{depth:0,parentId:null,metadata:{},id:'chat'},{}).queueRole).toBeUndefined();
  });
  it('preserves explicit tags and durability for root Codex chats',()=>{
    expect(applyInstanceSpawnPolicy('codex',{depth:0,parentId:null,metadata:{},id:'chat'},{})).toMatchObject({ephemeral:false,sessionKind:'chat'});
    expect(applyInstanceSpawnPolicy('codex',undefined,{machineSession:'review',sessionKind:'review',trialKey:'caller'})).toMatchObject({machineSession:'review',sessionKind:'review',trialKey:'caller'});
  });
  it('carries the raw trial key and its source across all provider spawns', () => {
    const queue = { depth: 1, parentId: 'parent', metadata: { planQueueRunId: 'run', planQueueItemId: 'item' }, id: 'worker' };
    expect(applyInstanceSpawnPolicy('codex', queue, {})).toMatchObject({ trialKey: 'item', trialKeySource: 'plan-queue-item' });
    expect(applyInstanceSpawnPolicy('claude', queue, { trialKey: 'explicit' })).toMatchObject({ trialKey: 'explicit' });
    expect(applyInstanceSpawnPolicy('claude', queue, { trialKey: 'explicit' }).trialKeySource).toBeUndefined();
  });
  it.each([['item-a', 'off'], ['item-d', 'full']] as const)(
    'keeps worker and verifier rounds in the %s item\'s %s trial group', (itemId, expectedArm) => {
      const rounds = [
        { id: 'worker-round-1', parentId: 'worker-parent-1', role: 'worker' },
        { id: 'verifier-round-1', parentId: 'verifier-parent-1', role: 'verifier' },
        { id: 'worker-round-2', parentId: 'worker-parent-2', role: 'worker' },
      ];
      for (const round of rounds) {
        const options = applyInstanceSpawnPolicy('codex', {
          id: round.id, parentId: round.parentId, depth: 1,
          metadata: { planQueueRunId: 'queue-run', planQueueItemId: itemId, planQueueRole: round.role },
        }, {});
        expect(options).toMatchObject({
          sessionKind: 'plan-queue', trialKey: itemId, trialKeySource: 'plan-queue-item',
        });
        expect(resolveTrialArm(options.trialKey, 'trial', true)).toBe(expectedArm);
      }
    },
  );
  it('uses the configured Claude output cap and preserves explicit spawn overrides', () => {
    _setOutputCapSettingsReaderForTesting((key) => key === 'claudeBashOutputMaxChars' ? 12_000 : undefined);
    const chat = { depth: 0, parentId: null, metadata: {}, id: 'chat' };
    expect(applyInstanceSpawnPolicy('claude', chat, {}).bashOutputMaxChars).toBe(12_000);
    expect(applyInstanceSpawnPolicy('claude', chat, { bashOutputMaxChars: 0 }).bashOutputMaxChars).toBe(0);
    expect(applyInstanceSpawnPolicy('codex', chat, {}).bashOutputMaxChars).toBeUndefined();
  });
});
