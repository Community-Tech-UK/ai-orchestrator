import type { InternalInputSource } from '../../../shared/types/input-provenance.types';

/**
 * The slice of a CLI adapter that orchestration response delivery uses.
 * `sendOrchestrationResponse` exists only on adapters that need turn-aware
 * delivery (Codex app-server); the rest fall back to `sendInput`.
 */
export interface OrchestrationResponseAdapter {
  sendInput(
    message: string,
    attachments?: undefined,
    options?: { internalSource?: InternalInputSource },
  ): Promise<void>;
  sendOrchestrationResponse?(message: string, onDelayed?: () => void): Promise<void>;
}
