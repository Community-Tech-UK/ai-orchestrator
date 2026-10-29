import { z } from 'zod';

/**
 * Schemas for browser.handle_dialog: answering a Chrome page pop-up (alert,
 * confirm, prompt, "Leave site?") that opened on a shared Chrome tab while a
 * Browser Gateway command was running there. Re-exported from
 * browser.schemas.ts. Self-contained: no imports from browser.schemas.ts, to
 * avoid an import cycle.
 */

const idSchema = z.string().min(1).max(200);

export const BrowserDialogTypeSchema = z.enum(['alert', 'confirm', 'prompt', 'beforeunload']);
export type BrowserDialogType = z.infer<typeof BrowserDialogTypeSchema>;

export const BrowserHandleDialogRequestSchema = z
  .object({
    profileId: idSchema,
    targetId: idSchema,
    /** true presses Leave / OK, false presses Stay / Cancel. */
    accept: z.boolean(),
    actionHint: z.string().min(1).max(500).optional(),
    requestId: idSchema.optional(),
  })
  .strict();
export type BrowserHandleDialogRequest = z.infer<typeof BrowserHandleDialogRequestSchema>;

export const BrowserHandleDialogResultSchema = z
  .object({
    handled: z.literal(true),
    accepted: z.boolean(),
    /** Withheld on a secret-filled tab, like every other page detail there. */
    dialogType: BrowserDialogTypeSchema.optional(),
  })
  .strict();
export type BrowserHandleDialogResult = z.infer<typeof BrowserHandleDialogResultSchema>;
