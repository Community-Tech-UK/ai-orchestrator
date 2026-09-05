export interface InstanceSendInputOptions {
  isRetry?: boolean;
  autoContinuation?: boolean;
  automatedInput?: boolean;
  signal?: AbortSignal;
  /** Final synchronous eligibility check run at the provider-dispatch boundary. */
  beforeProviderDispatch?: () => void;
}

export function throwIfInstanceInputAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  const error = new Error('Instance input was cancelled before provider dispatch');
  error.name = 'AbortError';
  throw error;
}
