/**
 * A session that asked for another computer and ended up on this Mac says why, once, in its transcript.
 * Drives the real `InstanceLifecycleManager.createInstance()`. The computer registry can't load under this fixture,
 * so the placement rules give their "can't be reached" reason; the reasons themselves are covered in
 * `default-computer-placement.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../../shared/types/instance.types';
import { getDefaultAgent } from '../../../shared/types/agent.types';
import * as placement from '../lifecycle/default-computer-placement';
import { WorkAdmission } from '../../work-admission/work-admission';
import { InstanceSpawnPreflightChain } from '../lifecycle/instance-spawn-preflight-chain';
import { getMocks, makeFakeAdapter, makeHarness } from './instance-lifecycle-source-diagnostics.fixture';

const mocks = getMocks();

describe('a session that asked for another computer and stayed on this Mac', () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdapter.mockReset();
    mocks.resolveCliType.mockResolvedValue('claude');
    mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
    mocks.supervisorRegister.mockReturnValue({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' });
    mocks.maybeGenerateTitle.mockResolvedValue(undefined);
    mocks.localModelInventory.length = 0;
    mocks.localModelRefresh.mockResolvedValue(mocks.localModelInventory);
    mocks.getProviderCapabilities.mockReturnValue({
      supportsResume: true, supportsForkSession: false, supportsNativeCompaction: false,
      supportsPermissionPrompts: false, supportsDeferPermission: false, selfManagedAutoCompaction: false,
    });
    mocks.continuityStartTracking.mockResolvedValue(undefined);
    mocks.continuityResumeSession.mockResolvedValue(null);
    mocks.evaluateResumeHealth.mockResolvedValue('healthy');
    mocks.resolveExecutionLocation.mockReturnValue({ type: 'local' });
    mocks.getKnownModelsForCli.mockResolvedValue([]);
    harness = makeHarness();
    mocks.createAdapter.mockReturnValue(makeFakeAdapter());
  });
  afterEach(() => harness.manager.destroy());

  it('shows one quiet line saying why, and runs here', async () => {
    const outputs: OutputMessage[] = [];
    harness.manager.on('output', (event: { message: OutputMessage }) => outputs.push(event.message));
    const instance = await harness.manager.createInstance({ workingDirectory: '/tmp/project', provider: 'claude', preferOtherComputer: true });
    await instance.readyPromise;
    const lines = outputs.filter(message => message.metadata?.['systemMessageKind'] === 'computer-choice');
    expect(lines.map(line => line.content)).toEqual(["Running on this Mac: the other computers can't be reached."]);
    expect(instance.executionLocation).toEqual({ type: 'local' });
  });

  it('says nothing when the session never asked', async () => {
    const outputs: OutputMessage[] = [];
    harness.manager.on('output', (event: { message: OutputMessage }) => outputs.push(event.message));
    const instance = await harness.manager.createInstance({ workingDirectory: '/tmp/project', provider: 'claude' });
    await instance.readyPromise;
    expect(outputs.filter(message => message.metadata?.['systemMessageKind'] === 'computer-choice')).toEqual([]);
  });

  it("holds a job admitted as going elsewhere until this Mac is free when it ends up here", async () => {
    const admission = new WorkAdmission({ cpuCount: () => 1, loadAverage: () => [100, 100, 100] });
    admission.setWorkloadLevel(1);
    vi.spyOn(WorkAdmission, 'getInstance').mockReturnValue(admission);
    const prepare = vi.spyOn(InstanceSpawnPreflightChain.prototype, 'prepare').mockRejectedValue(new Error('stop once it starts'));
    try {
      await harness.manager.createInstance({ workingDirectory: '/tmp/project', provider: 'claude', preferOtherComputer: true, admittedAsOtherComputer: true }).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(prepare).not.toHaveBeenCalled();
      admission.setWorkloadLevel(3);
      admission.notifyChanged();
      await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    } finally {
      prepare.mockRestore();
      admission.dispose();
      WorkAdmission._resetForTesting();
    }
  });

  it("starts a job admitted as going elsewhere straight away when it did go elsewhere", async () => {
    const admission = new WorkAdmission({ cpuCount: () => 1, loadAverage: () => [100, 100, 100] });
    admission.setWorkloadLevel(1);
    vi.spyOn(WorkAdmission, 'getInstance').mockReturnValue(admission);
    vi.spyOn(placement, 'resolveNewSessionPlacement').mockReturnValue({ location: { type: 'remote', nodeId: 'pc' }, accountProfileId: 'work' });
    const prepare = vi.spyOn(InstanceSpawnPreflightChain.prototype, 'prepare').mockRejectedValue(new Error('stop once it starts'));
    try {
      await harness.manager.createInstance({ workingDirectory: '/tmp/project', provider: 'claude', preferOtherComputer: true, admittedAsOtherComputer: true }).catch(() => undefined);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    } finally {
      prepare.mockRestore();
      admission.dispose();
      WorkAdmission._resetForTesting();
    }
  });

  it('starts a session on the account its computer was picked for', async () => {
    vi.spyOn(placement, 'resolveNewSessionPlacement').mockReturnValue({ location: { type: 'remote', nodeId: 'pc' }, accountProfileId: 'work' });
    const prepare = vi.spyOn(InstanceSpawnPreflightChain.prototype, 'prepare').mockRejectedValue(new Error('stop after the account is chosen'));
    await harness.manager.createInstance({ workingDirectory: '/tmp/project', provider: 'claude', preferOtherComputer: true }).catch(() => undefined);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    expect(prepare.mock.calls[0]?.[0].config).toMatchObject({ accountProfileId: 'work' });
    prepare.mockRestore();
  });
});
