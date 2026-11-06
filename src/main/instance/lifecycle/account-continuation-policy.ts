/**
 * How an account handoff continues the conversation (spec D3): one source of
 * truth, shared by the reconciler that executes the handoff and by the
 * pre-click cost preview that must describe the same continuity.
 *
 * The pool's configured mode decides; outside a pool (or when the store is
 * unavailable) the conversation is replayed into a fresh provider session.
 */

import { isPooledProvider, type AccountContinuationMode } from '../../../shared/types/provider-account.types';
import { getProviderAccountStore } from '../../providers/account-pool/provider-account-store';

/** The effective continuation mode for a handoff on `provider`. */
export function readAccountContinuation(provider: string): AccountContinuationMode {
  if (!isPooledProvider(provider)) return 'replay';
  try {
    return getProviderAccountStore().getPoolPolicy(provider).continuation;
  } catch {
    return 'replay';
  }
}
