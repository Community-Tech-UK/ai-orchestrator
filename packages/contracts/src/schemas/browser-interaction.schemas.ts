import { z } from 'zod';

const urlSchema = z.string().min(1).max(2000);
const browserWebUrlSchema = urlSchema.refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}, 'Browser Gateway existing tabs must use http or https URLs.');

const elementUidSchema = z.string().min(1).max(64);

export const BrowserAccessibilityNodeSchema = z
  .object({
    uid: elementUidSchema,
    role: z.string().min(1).max(120),
    name: z.string().max(2000).optional(),
    value: z.string().max(2000).optional(),
    description: z.string().max(2000).optional(),
    checked: z.union([z.boolean(), z.enum(['mixed'])]).optional(),
    selected: z.boolean().optional(),
    expanded: z.boolean().optional(),
    disabled: z.boolean().optional(),
    focused: z.boolean().optional(),
    level: z.number().int().min(0).max(20).optional(),
  })
  .strict();

export const BrowserEvaluateResultSchema = z
  .object({
    json: z.string().max(20_000).optional(),
    type: z.string().min(1).max(60).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

export const BrowserSelectOptionSchema = z
  .object({
    value: z.string().max(200),
    label: z.string().max(200),
    selected: z.boolean(),
  })
  .strict();

export const BrowserElementCandidateSchema = z
  .object({
    selector: z.string().min(1).max(2000),
    tagName: z.string().min(1).max(120),
    role: z.string().min(1).max(120).optional(),
    accessibleName: z.string().min(1).max(500).optional(),
    text: z.string().max(1000).optional(),
    inputType: z.string().min(1).max(120).optional(),
    placeholder: z.string().min(1).max(500).optional(),
    href: browserWebUrlSchema.optional(),
    value: z.string().max(1000).optional(),
    selectedOption: z.string().max(200).optional(),
    checked: z.boolean().optional(),
    disabled: z.boolean().optional(),
    expanded: z.boolean().optional(),
    options: z.array(BrowserSelectOptionSchema).max(50).optional(),
  })
  .strict();
