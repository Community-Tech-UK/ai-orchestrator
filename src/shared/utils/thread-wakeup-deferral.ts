/**
 * The reason recorded on a thread wake-up run that came due while its conversation was mid-turn. Harness holds the prompt
 * and sends it when the turn ends, so the run is `skipped` with this text and its prompt not yet delivered. The renderer
 * recognises the held run by this text, so main and renderer share the one constant.
 */
export const THREAD_WAKEUP_DEFERRED_BUSY = 'That conversation was busy. Harness will send this when its current turn ends.';
