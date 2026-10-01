/**
 * Fold the main process's sticky `automationRevealed` stamp into renderer
 * metadata. Metadata otherwise arrives only when an instance is created, and
 * the project rail reads the stamp from metadata to keep a hidden automation's
 * session visible once it failed, lost its automation, or was taken over.
 */
export function withAutomationRevealed(
  metadata: Record<string, unknown> | undefined,
  automationRevealed: boolean | undefined,
): Record<string, unknown> | undefined {
  if (automationRevealed !== true || metadata?.['automationRevealed'] === true) {
    return metadata;
  }
  return { ...metadata, automationRevealed: true };
}
