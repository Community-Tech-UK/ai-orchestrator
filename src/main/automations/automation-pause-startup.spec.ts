import { expect, it, vi } from 'vitest';
import { AutomationPauseStartup } from './automation-pause-startup';
import { ThreadWakeupRunner } from './thread-wakeup-runner';
import { AutomationLoopRunDispatcher } from './automation-loop-run';
import { pauseConsults } from '../work-admission/consult-admission';
import { WorkAdmission } from '../work-admission/work-admission';
import type { ClaimedAutomationRun } from '../../shared/types/automation.types';

const ports = vi.hoisted(() => ({ pauseLoop: vi.fn(), admit: vi.fn() }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({ pauseForGlobalPause: ports.pauseLoop }) }));
vi.mock('../session/session-admission-service', () => ({ getSessionAdmissionService: () => ({ registerRedeliveryHandler: vi.fn(), admitAutomatedWrite: ports.admit }) }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const claimed = {run: {id:'run',automationId:'automation'},snapshot: {name:'Work',action:{prompt:'Original work',workingDirectory:'/tmp',loop:{verifyCommand:'npm test'}},destination:{kind:'newInstance'}}} as ClaimedAutomationRun;

it('cancels a thread wakeup awaiting revival without delivering, failing the run or closing a manual chat', async () => {
  WorkAdmission._resetForTesting();
  const revived = deferred(); const entered = deferred();
  const sendInput = vi.fn(); const interruptInstance = vi.fn();
  const attachInstance = vi.fn(); const terminalizeRun = vi.fn();
  const wakeup = new ThreadWakeupRunner({sendInput,interruptInstance,getInstance:()=>({status:'idle'}),waitForInstanceSettled:vi.fn()} as never,
    {revive:async()=>{entered.resolve();await revived.promise;return {status:'live',instanceId:'manual-chat'};}} as never,
    {attachInstance,terminalizeRun} as never);
  const owner = new AutomationPauseStartup();
  const paused = vi.fn();
  const starting = owner.run('run', async startup => { await wakeup.fireThreadWakeup({run:claimed.run,
    automation:{action:claimed.snapshot.action} as never,destination:{kind:'thread',instanceId:'manual-chat',reviveIfArchived:true},startup}); }, paused);
  await entered.promise;
  let safe=false; const pausing=pauseConsults().then(()=>{safe=true;});
  await new Promise<void>(resolve=>setImmediate(resolve)); expect(safe).toBe(false);
  revived.resolve(); await starting; await pausing;
  expect(paused).toHaveBeenCalledOnce(); expect(sendInput).not.toHaveBeenCalled();
  expect(terminalizeRun).not.toHaveBeenCalled(); expect(attachInstance).not.toHaveBeenCalled(); expect(interruptInstance).not.toHaveBeenCalled();
  WorkAdmission._resetForTesting();
});

it('keeps a late automation loop linked and waits until its pause completes', async () => {
  WorkAdmission._resetForTesting();
  const creating=deferred(),entered=deferred(),stopping=deferred(),stopEntered=deferred();
  ports.pauseLoop.mockImplementation(async()=>{stopEntered.resolve();await stopping.promise;});
  const attachLoopRun=vi.fn(()=>claimed.run),terminalizeRun=vi.fn();
  const dispatcher=new AutomationLoopRunDispatcher({store:{attachLoopRun,terminalizeRun},now:Date.now,onTerminal:vi.fn(),prepareConfig:async config=>config,
    startLoop:async()=>{entered.resolve();await creating.promise;return {id:'late-loop'};},subscribeLoopStateChanged:vi.fn()});
  const owner=new AutomationPauseStartup(); const paused=vi.fn();
  const starting=owner.run('run',startup=>dispatcher.dispatch(claimed,startup),paused);
  await entered.promise; let safe=false; const pausing=pauseConsults().then(()=>{safe=true;});
  creating.resolve(); await stopEntered.promise;
  expect(safe).toBe(false); expect(attachLoopRun).toHaveBeenCalledWith('run','late-loop',expect.any(Number));
  stopping.resolve(); await starting; await pausing;
  expect(ports.pauseLoop).toHaveBeenCalledWith('late-loop'); expect(terminalizeRun).not.toHaveBeenCalled(); expect(paused).toHaveBeenCalledOnce();
  WorkAdmission._resetForTesting();
});
