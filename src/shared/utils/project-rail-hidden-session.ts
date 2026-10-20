/**
 * Internal worker/probe sessions (run_on_node workers, ping-pong reviewers) that
 * the project rail never shows. History keeps them, marked hidden, and session
 * recovery never offers them back to the user.
 */
export function isProjectRailHiddenSession(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.['hideFromProjectRail'] === true
    || typeof metadata?.['spawnDepth'] === 'number';
}
