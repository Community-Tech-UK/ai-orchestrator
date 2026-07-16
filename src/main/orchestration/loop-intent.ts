/**
 * Re-export shim — the pure loop intent detector moved to
 * `src/shared/utils/loop-intent.ts` (WS6: the renderer's start-config panel
 * needs the same classification for submit gating, and shared code must not
 * import from `src/main`). All existing main-process import sites keep
 * working through this module.
 */

export * from '../../shared/utils/loop-intent';
