import * as path from 'node:path';
import { app } from 'electron';
import type { AccountTrialOperations } from '../../shared/types/account-trial.types';
import type { InstanceManager } from '../instance/instance-manager';
import { createInstanceWithMessage } from '../ipc/handlers/instance-create-with-message';
import { getLogger } from '../logging/logger';
import { AccountTrialLeaseService } from '../providers/account-pool/account-trial-lease-service';
import { getProviderAccountStore } from '../providers/account-pool/provider-account-store';
import { registerCleanup } from '../util/cleanup-registry';

const logger = getLogger('AccountTrialWiring');
const SWEEP_INTERVAL_MS = 30_000;
const START_TIMEOUT_MS = 120_000;

/**
 * `createInstance` returns before the account route is checked and the CLI starts; a refused account (signed out,
 * identity mismatch, disabled) only shows up when that background start fails. Wait for it, so the caller gets the
 * refusal as an error instead of a session id for a session that never ran, and stop what did not start.
 */
async function confirmSessionStarted(instanceManager: InstanceManager, instanceId: string): Promise<void> {
  let failure: string | null = null;
  const ready = instanceManager.getInstance(instanceId)?.readyPromise;
  if (ready) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`did not start within ${START_TIMEOUT_MS / 1000} seconds`)), START_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
  }
  if (failure === null && instanceManager.getInstance(instanceId)?.status === 'failed') {
    failure = 'the session failed while starting';
  }
  if (failure !== null) {
    await instanceManager.terminateInstance(instanceId).catch((error: unknown) => {
      logger.warn('account_trial could not stop a session that failed to start', {
        instanceId, error: error instanceof Error ? error.message : String(error),
      });
    });
    throw new Error(`The session could not start on that account: ${failure}`);
  }
}

/**
 * Starts the `account_trial` lease service against the real account store and instance manager.
 * Leases left by a previous run are ended first, so a crash cannot leave an account policy changed.
 */
export async function startAccountTrial(
  instanceManager: InstanceManager,
): Promise<AccountTrialOperations> {
  const service = new AccountTrialLeaseService({
    store: getProviderAccountStore(),
    filePath: path.join(app.getPath('userData'), 'account-trial-leases.json'),
    isInstanceLive: (instanceId) => {
      const status = instanceManager.getInstance(instanceId)?.status;
      return status !== undefined && status !== 'terminated' && status !== 'failed';
    },
    startSession: async ({ ownerInstanceId, provider, profileId, prompt, model, workingDirectory, name }) => {
      const directory = workingDirectory ?? instanceManager.getInstance(ownerInstanceId)?.workingDirectory;
      if (!directory) throw new Error('Pass workingDirectory: the calling session has no folder to default to.');
      const response = await createInstanceWithMessage(
        instanceManager,
        { message: prompt, provider, accountProfileId: profileId, ...(model ? { model } : {}), ...(name ? { displayName: name } : {}) },
        directory,
        undefined,
      );
      const instanceId = (response.data as { id?: unknown } | undefined)?.id;
      if (typeof instanceId !== 'string') throw new Error('The session was created but its id was not returned.');
      await confirmSessionStarted(instanceManager, instanceId);
      return { instanceId };
    },
    terminateSession: async (instanceId) => {
      if (instanceManager.getInstance(instanceId)) await instanceManager.terminateInstance(instanceId);
    },
  });
  await service.recover();
  const sweep = setInterval(() => {
    void service.sweep().catch((error) => {
      logger.warn('account_trial sweep failed', { error: error instanceof Error ? error.message : String(error) });
    });
  }, SWEEP_INTERVAL_MS);
  sweep.unref();
  registerCleanup(async () => {
    clearInterval(sweep);
    await service.recover();
  });
  return service;
}
