/**
 * 4a change 3 — the renderer's loop view-focus report (`LOOP_VIEW_FOCUS`).
 *
 * Its own file rather than an addition to `loop.schemas.ts`, which sits at the
 * exact top of its LOC ratchet (935 lines). A separate `@contracts/schemas/
 * loop-view-focus` subpath follows the AGENTS.md alias-registration procedure.
 */
import { z } from 'zod';

/** The loop the HUD shows right now; `null` when no loop is on screen. */
export const LoopViewFocusPayloadSchema = z.object({
  loopRunId: z.string().min(1).nullable(),
});

export type LoopViewFocusPayload = z.infer<typeof LoopViewFocusPayloadSchema>;
