/**
 * Production wiring for the account failover coordinator: the shared store,
 * binding service, ledger and quota evidence, plus the notification service.
 * InstanceManager supplies the instance-facing callbacks.
 */

import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
import { getProviderLimitLedgerPort } from '../../core/system/provider-limit-ledger';
import { getNotificationService } from '../../notifications/notification-service';
import {
  configureAccountFailoverCoordinator,
  type AccountFailoverCoordinator,
} from './account-failover-coordinator';
import { readAccountQuotaEvidence } from './account-quota-evidence';
import { getProviderAccountBindingService } from './provider-account-binding-service';
import { getProviderAccountStore } from './provider-account-store';

export { currentAccountProfileId } from './account-failover-coordinator';

export function createAccountFailoverCoordinator(deps: {
  getInstance: (instanceId: string) => Instance | undefined;
  applyRuntimeChange: (instanceId: string, desired: DesiredRuntime) => Promise<Instance>;
  resendInput: (instanceId: string, prompt: string) => void;
}): AccountFailoverCoordinator {
  return configureAccountFailoverCoordinator({
    ...deps,
    store: getProviderAccountStore,
    bindings: getProviderAccountBindingService,
    getParkedProfileIds: (provider, model) => getProviderLimitLedgerPort().getParkedProfileIds({ provider, model }),
    getQuotaEvidence: readAccountQuotaEvidence,
    notify: (input) => {
      getNotificationService().notify({ ...input, urgency: 'normal' });
    },
  });
}
