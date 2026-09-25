import type { InternalInputSource } from '../../shared/types/input-provenance.types';

export interface InstanceSendInputOptions {
  isRetry?: boolean;
  autoContinuation?: boolean;
  automatedInput?: boolean;
  signal?: AbortSignal;
  /** Final synchronous eligibility check run at the provider-dispatch boundary. */
  beforeProviderDispatch?: () => void;
  /**
   * Set by `CrossSessionMessagingService` when this send is a delivered
   * cross-session message rather than user- or automation-originated input.
   * Threaded through so the stored `OutputMessage` can carry
   * `metadata.crossSessionMessage` for distinct renderer styling.
   */
  crossSessionSourceId?: string;
  /** Sender's display name at send time, captured by the service (Instance.displayName). */
  crossSessionSourceDisplayName?: string;
  /** Hop count computed by the loop guard; carried onto the stored message's metadata. */
  crossSessionHopCount?: number;
  /**
   * Set when Harness itself authored this text (LT-657). The message is stored
   * as a Harness system message, kept out of prompt history and slash-command
   * resolution, and wrapped so the provider cannot read it as the user's words.
   */
  internalSource?: InternalInputSource;
}

export function throwIfInstanceInputAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  const error = new Error('Instance input was cancelled before provider dispatch');
  error.name = 'AbortError';
  throw error;
}
