/**
 * Typed error thrown by pause gates so callers can distinguish deliberate
 * pause refusal from provider, network, or process failures.
 */
export class OrchestratorPausedError extends Error {
  override readonly name = 'OrchestratorPausedError';
  readonly code = 'ORCHESTRATOR_PAUSED';
  readonly hostname?: string;

  constructor(message = 'Orchestrator is paused', opts?: { hostname?: string }) {
    super(message);
    this.hostname = opts?.hostname;
  }
}

export function isOrchestratorPausedError(error: unknown): error is OrchestratorPausedError {
  return error instanceof OrchestratorPausedError;
}
