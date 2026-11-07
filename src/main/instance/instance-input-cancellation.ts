import type { InputContextDelivery } from '../../shared/types/input-context-delivery.types';
import type { InternalInputSource, PersonInputOrigin } from '../../shared/types/input-provenance.types';
import type { AdapterInputRetryReason } from '../cli/adapters/base-cli-adapter.types';

export interface InstanceSendInputOptions {
  isRetry?: boolean;
  /** Exact transcript bubble for one logical user send, shared by safe retries. */
  userMessageId?: string;
  /** Durable user queue row to claim exactly once at provider dispatch. */
  queuedAdmissionId?: string;
  /** Original published user turn, retained across resolved-turn retries. */
  inputMessageId?: string;
  inputContextDelivery?: InputContextDelivery;
  autoContinuation?: boolean;
  automatedInput?: boolean;
  /**
   * Set only for words a person typed or spoke themselves (see `PersonInputOrigin`).
   * Stored on the user message; ignored for Harness-written or cross-session text.
   */
  origin?: PersonInputOrigin;
  signal?: AbortSignal;
  /** Final synchronous eligibility check run at the provider-dispatch boundary. */
  beforeProviderDispatch?: () => void;
  /** Observation only: successful provider send, including accepted recovery retries. */
  onProviderInputDelivered?: () => void;
  /** Repeatable owner check across later native writes, after the admission callback has committed. */
  assertProviderDispatchCurrent?: (retryReason?: AdapterInputRetryReason) => void;
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
  /** Selected provider catalog command; must be revalidated at native dispatch. */
  providerNativeCommandId?: string;
}

export function throwIfInstanceInputAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  const error = new Error('Instance input was cancelled before provider dispatch');
  error.name = 'AbortError';
  throw error;
}

/** Automatic provenance must survive every manager and retry handoff. */
export function isAutomaticInstanceInput(options?: InstanceSendInputOptions): boolean {
  return Boolean(options?.autoContinuation || options?.automatedInput || options?.internalSource || options?.crossSessionSourceId);
}
