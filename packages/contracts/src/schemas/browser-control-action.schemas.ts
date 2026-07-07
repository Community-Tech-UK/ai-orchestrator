import { z } from 'zod';

export const elementUidSchema = z.string().min(1).max(64);

export function requireSelectorOrUid(
  value: { selector?: string; uid?: string },
  ctx: z.RefinementCtx,
): void {
  if (!value.selector && !value.uid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selector'],
      message: 'Browser action requires a selector or a uid.',
    });
  }
}

export const BrowserControlVerifyExpectationSchema = z
  .object({
    selector: z.string().min(1).max(2000).optional(),
    uid: elementUidSchema.optional(),
    value: z.string().max(20_000).optional(),
    selectedLabel: z.string().max(2_000).optional(),
    checked: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.value === undefined &&
      value.selectedLabel === undefined &&
      value.checked === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'Browser verify requires value, selectedLabel, or checked.',
      });
    }
  });
