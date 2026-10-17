/** Main-only ownership hook; do not resolve durable storage while constructing an adapter. */
export function createProviderPromptCheckpoint(instanceId: string): () => Promise<void> {
  return async () => {
    const { getSessionContinuityManager } = await import('../../session/session-continuity');
    await getSessionContinuityManager().prepareForProviderTurn(instanceId);
  };
}
