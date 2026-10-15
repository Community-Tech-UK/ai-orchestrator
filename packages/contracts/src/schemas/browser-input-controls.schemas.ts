import { z } from 'zod';

/**
 * Schemas for browser.press_key / browser.set_viewport / browser.set_zoom —
 * native keyboard input, viewport control and real Chrome zoom. Kept in a
 * sibling file (re-exported from browser.schemas.ts) so the main browser
 * schema module stays under the file-size ceiling. Self-contained: no imports
 * from browser.schemas.ts, to avoid an import cycle.
 */

const idSchema = z.string().min(1).max(200);

/**
 * Named keys press_key accepts. Printable CHARACTERS (letters, digits,
 * punctuation) are deliberately absent: text entry stays on browser.type,
 * where the credential, financial-identity and sensitive-identity hard stops
 * can see the field being written. Enter and Space may insert '\r' / ' ' into
 * an editable field as part of their default behaviour, but both are
 * activation-gated (explicit authority required) so nothing is typed
 * unapproved.
 */
export const BrowserPressKeySchema = z.enum([
  'Tab',
  'Enter',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
  'Backspace',
  'Delete',
]);
export type BrowserPressKey = z.infer<typeof BrowserPressKeySchema>;

export const BrowserPressKeyModifierSchema = z.enum([
  'Alt',
  'Control',
  'Meta',
  'Shift',
]);
export type BrowserPressKeyModifier = z.infer<typeof BrowserPressKeyModifierSchema>;

/** Keys whose default action can activate whatever currently has focus. */
export const ACTIVATION_KEYS: ReadonlySet<BrowserPressKey> = new Set([
  'Enter',
  'Space',
]);

const BrowserEffectExpectationSchema = z
  .object({
    selector: z.string().min(1).max(2000).optional(),
    urlContains: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.selector || value.urlContains), {
    message: 'expectChange requires selector or urlContains',
  });

export const BrowserPressKeyRequestSchema = z
  .object({
    profileId: idSchema,
    targetId: idSchema,
    key: BrowserPressKeySchema,
    modifiers: z.array(BrowserPressKeyModifierSchema).max(3).optional(),
    actionHint: z.string().min(1).max(500).optional(),
    expectUrlChange: z.boolean().optional(),
    expectChange: BrowserEffectExpectationSchema.optional(),
    /**
     * Retry-dedupe token: a repeat press with the same key (within a short
     * window on the executing side) returns the original result instead of
     * pressing again, so a retried Enter cannot double-activate.
     */
    idempotencyKey: z.string().min(1).max(200).optional(),
    requestId: idSchema.optional(),
  })
  .strict();
export type BrowserPressKeyRequest = z.infer<typeof BrowserPressKeyRequestSchema>;

/** Secret-free description of the focused element after a key press. */
export const BrowserFocusInfoSchema = z
  .object({
    tagName: z.string().min(1).max(120).optional(),
    role: z.string().max(120).optional(),
    id: z.string().max(200).optional(),
    name: z.string().max(200).optional(),
    type: z.string().max(120).optional(),
    ariaLabel: z.string().max(500).optional(),
    /** Truncated visible text for non-secret elements only; never input values. */
    text: z.string().max(300).optional(),
    href: z.string().max(2000).optional(),
    editable: z.boolean().optional(),
  })
  .strict();
export type BrowserFocusInfo = z.infer<typeof BrowserFocusInfoSchema>;

export const BrowserPressKeyResultSchema = z
  .object({
    applied: z.boolean(),
    key: BrowserPressKeySchema,
    modifiers: z.array(BrowserPressKeyModifierSchema),
    /** Set when an idempotencyKey repeat returned the original result. */
    deduplicated: z.boolean().optional(),
    focus: BrowserFocusInfoSchema.optional(),
    url: z.string().max(2000).optional(),
    title: z.string().max(500).optional(),
  })
  .strict();
export type BrowserPressKeyResult = z.infer<typeof BrowserPressKeyResultSchema>;

export const BrowserViewportScopeSchema = z.enum(['tab', 'window']);
export type BrowserViewportScope = z.infer<typeof BrowserViewportScopeSchema>;

export const BrowserViewportDimensionsSchema = z
  .object({
    innerWidth: z.number().int().min(0).max(20_000),
    innerHeight: z.number().int().min(0).max(20_000),
  })
  .strict();
export type BrowserViewportDimensions = z.infer<typeof BrowserViewportDimensionsSchema>;

export const BrowserSetViewportRequestSchema = z
  .object({
    profileId: idSchema,
    targetId: idSchema,
    /** Target content width in CSS pixels (device pixels at 100% zoom). */
    width: z.number().int().min(100).max(10_000).optional(),
    /** Target content height in CSS pixels. */
    height: z.number().int().min(100).max(10_000).optional(),
    /**
     * 'tab' (default) emulates the viewport of the selected tab only and
     * touches nothing else. 'window' resizes the real Chrome window — a
     * window-wide operation affecting every tab in it. Neither stands in for
     * the other; the result reports which one ran.
     */
    scope: BrowserViewportScopeSchema.optional(),
    /** Clear emulation / restore the recorded original window bounds. */
    reset: z.boolean().optional(),
    requestId: idSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasSize = value.width !== undefined || value.height !== undefined;
    if (hasSize && (value.width === undefined || value.height === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['width'],
        message: 'browser.set_viewport requires both width and height.',
      });
    }
    if (hasSize && value.reset === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reset'],
        message: 'browser.set_viewport cannot set a size and reset in one call.',
      });
    }
  });
export type BrowserSetViewportRequest = z.infer<typeof BrowserSetViewportRequestSchema>;

export const BrowserViewportWindowInfoSchema = z
  .object({
    windowId: z.number().int(),
    /** Other tabs left in the resized window (tab ids, machine-specific). */
    otherTabIds: z.array(z.number().int()).max(200),
    bounds: z
      .object({
        left: z.number().int(),
        top: z.number().int(),
        width: z.number().int(),
        height: z.number().int(),
      })
      .strict(),
  })
  .strict();
export type BrowserViewportWindowInfo = z.infer<typeof BrowserViewportWindowInfoSchema>;

export const BrowserSetViewportResultSchema = z
  .object({
    /** Which mechanism ran. Never ambiguous: emulation ≠ window resize. */
    mode: z.enum(['tab_emulation', 'window_resize', 'reset', 'read']),
    scope: BrowserViewportScopeSchema,
    requested: z
      .object({ width: z.number().int(), height: z.number().int() })
      .strict()
      .optional(),
    /** Actual page content box after the change (window.innerWidth/innerHeight). */
    actual: BrowserViewportDimensionsSchema,
    /** Emulation state now in force (tab scope). */
    emulation: z
      .object({
        width: z.number().int().min(0),
        height: z.number().int().min(0),
        deviceScaleFactor: z.number().min(0).max(10),
      })
      .strict()
      .optional(),
    /** Window info for scope: 'window' (identity + affected tabs + bounds). */
    window: BrowserViewportWindowInfoSchema.optional(),
    /** State before the change, for explicit restoration by the caller. */
    previous: z
      .object({
        emulationActive: z.boolean(),
        emulationWidth: z.number().int().min(0).optional(),
        emulationHeight: z.number().int().min(0).optional(),
        windowBounds: BrowserViewportWindowInfoSchema.shape.bounds.optional(),
      })
      .strict()
      .optional(),
    /** Explicit when a restore could not be completed. */
    restorationFailed: z.string().max(500).optional(),
  })
  .strict();
export type BrowserSetViewportResult = z.infer<typeof BrowserSetViewportResultSchema>;

export const BrowserSetZoomRequestSchema = z
  .object({
    profileId: idSchema,
    targetId: idSchema,
    /** Chrome zoom factor: 1 = 100%, 2 = 200%. */
    zoomFactor: z.number().min(0.25).max(5).optional(),
    /** Restore the zoom factor and zoom settings recorded before the first change. */
    reset: z.boolean().optional(),
    requestId: idSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.zoomFactor !== undefined && value.reset === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reset'],
        message: 'browser.set_zoom cannot set a factor and reset in one call.',
      });
    }
  });
export type BrowserSetZoomRequest = z.infer<typeof BrowserSetZoomRequestSchema>;

export const BrowserSetZoomResultSchema = z
  .object({
    mode: z.enum(['set', 'read', 'reset']),
    /** Actual Chrome zoom factor after the call (never CSS/transform scale). */
    zoomFactor: z.number().min(0).max(10),
    zoomPercent: z.number().min(0).max(1000),
    previousZoomFactor: z.number().min(0).max(10).optional(),
    /** Zoom scope now in force ('per-tab' after a set, original after reset). */
    zoomScope: z.string().max(60).optional(),
    previousZoomScope: z.string().max(60).optional(),
    viewport: BrowserViewportDimensionsSchema,
    /** Explicit when a restore could not be completed. */
    restorationFailed: z.string().max(500).optional(),
  })
  .strict();
export type BrowserSetZoomResult = z.infer<typeof BrowserSetZoomResultSchema>;
