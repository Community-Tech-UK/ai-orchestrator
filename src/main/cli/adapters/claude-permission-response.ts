/** Prefix for live denials and typed held-call notes; plain held Reject keeps its legacy reason. */
export const HARNESS_DENY_PREFIX = 'Harness: the user declined this call. ';
export const HARNESS_INTERACTIVE_DENY = HARNESS_DENY_PREFIX
  + 'The question is shown to them on screen; end your turn and wait for their reply.';
