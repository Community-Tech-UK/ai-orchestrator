/**
 * Instances whose Claude process is being restarted to run a tool call a person
 * just approved. The restarted process replays that call at once, while the
 * instance is still `respawning`, so tool servers must accept it. The mark
 * is removed when the resume ends, whether it worked or not.
 */
const resuming = new Set<string>();

export function markDeferredPermissionResume(instanceId: string): void {
  resuming.add(instanceId);
}

export function clearDeferredPermissionResume(instanceId: string): void {
  resuming.delete(instanceId);
}

export function isResumingAfterDeferredPermission(instanceId: string): boolean {
  return resuming.has(instanceId);
}
