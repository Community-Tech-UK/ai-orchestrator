/**
 * A provider CLI explicitly reported that its own credentials rejected a turn.
 *
 * This is stronger evidence than auth-shaped prose: a separate status command
 * may already see refreshed shared credentials while the process that emitted
 * this error is still holding an expired OAuth token. Instance recovery uses
 * this marker to restart that process instead of incorrectly vetoing repair.
 */
export class ProviderAuthenticationError extends Error {
  readonly providerAuthenticationFailure = true;

  constructor(
    message: string,
    readonly providerErrorCode?: string,
  ) {
    super(message);
    this.name = 'ProviderAuthenticationError';
  }
}

export function isProviderAuthenticationError(
  value: unknown,
): value is ProviderAuthenticationError {
  return value instanceof Error
    && (value as Partial<ProviderAuthenticationError>).providerAuthenticationFailure === true;
}
