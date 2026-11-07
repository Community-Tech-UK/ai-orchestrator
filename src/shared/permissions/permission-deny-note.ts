import type { InputRequiredResponsePayload } from '@contracts/schemas/instance';

/** The marker means the user typed a note; the validated response supplies its bounded text. */
export function permissionDenyNote(payload: InputRequiredResponsePayload): string | undefined {
  const marker = payload.metadata?.['denyNote'];
  return payload.decisionAction === 'deny' && typeof marker === 'string' && marker.trim()
    ? payload.response.trim() || undefined : undefined;
}
