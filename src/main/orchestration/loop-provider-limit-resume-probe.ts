import type { ProviderId, ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import { EARLY_RESUME_PROBE_MS } from '../instance/instance-provider-limit-handler';

/** One park's quota probe. Cancelled refreshes cannot act on a later park of the same loop. */
export function startLoopProviderLimitResumeProbe(params: {
  provider: ProviderId;
  accountProfileId: string | null;
  resumeAt: number;
  refresh: (provider: ProviderId, accountProfileId: string | null) => Promise<ProviderQuotaSnapshot | null>;
  isArmed: () => boolean;
  snapshotAllowsResume: (snapshot: ProviderQuotaSnapshot | null) => boolean;
  onLifted: () => void;
}): () => void {
  let inFlight = false;
  let disposed = false;
  const timer = setInterval(() => {
    if (disposed || !params.isArmed() || inFlight) return;
    if (params.resumeAt - Date.now() < 60_000) return;
    inFlight = true;
    void params.refresh(params.provider, params.accountProfileId)
      .then((snapshot) => {
        if (disposed || !params.isArmed() || !params.snapshotAllowsResume(snapshot)) return;
        params.onLifted();
      })
      .catch(() => {
        // Failed refresh proves nothing; this park stays armed unless cancelled.
      })
      .finally(() => {
        inFlight = false;
      });
  }, EARLY_RESUME_PROBE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    disposed = true;
    clearInterval(timer);
  };
}
