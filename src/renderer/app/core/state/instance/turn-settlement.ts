interface TurnProjection {
  status?: string;
  activeTurnId?: string;
  restartEpoch?: number;
  adapterGeneration?: number;
}

// Main clears its active turn on ready-for-input and terminal transitions. The
// existing wire contract may omit that undefined field, so status carries the
// clearing signal. Waiting for permission and stopping still own a live turn.
const SETTLED = new Set([
  'idle', 'ready', 'waiting_for_input', 'error', 'failed', 'terminated',
  'cancelled', 'superseded',
]);

/** Project an optional wire field without retaining a turn that main settled. */
export function projectActiveTurnId(previous: TurnProjection, update: TurnProjection): string | undefined {
  const previousEpoch = previous.restartEpoch ?? 0;
  const nextEpoch = update.restartEpoch ?? previousEpoch;
  if (nextEpoch < previousEpoch) return previous.activeTurnId;
  if (nextEpoch === previousEpoch
    && (update.adapterGeneration ?? previous.adapterGeneration ?? 0) < (previous.adapterGeneration ?? 0)) {
    return previous.activeTurnId;
  }
  // An explicit id proves there is still a turn, even for a live question or a
  // settled-looking snapshot from a newer adapter. Never infer it away.
  if (update.activeTurnId !== undefined) return update.activeTurnId;
  if (update.status && SETTLED.has(update.status)) return undefined;
  return previous.activeTurnId;
}
