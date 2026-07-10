import { z } from 'zod';

export const REVIEW_SEVERITY_VALUES = ['critical', 'high', 'medium', 'low'] as const;

export const ReviewSeveritySchema = z.enum(REVIEW_SEVERITY_VALUES);

export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

export const ReviewFindingPayloadSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  category: z.string().min(1),
  severity: ReviewSeveritySchema,
  confidence: z.number().min(0).max(100),
  dimensionScores: z.record(z.string(), z.number()).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  suggestion: z.string().optional(),
  codeSnippet: z.string().optional(),
});

export const REVIEW_SEVERITY_RUBRIC = `Use this severity contract:
- **critical**: Exploitable, destructive, or correctness failure with severe impact and no safe workaround.
- **high**: Material defect likely to block release or change the result.
- **medium**: Real defect with bounded impact or a practical workaround.
- **low**: Limited-impact problem or worthwhile robustness improvement.`;

export const REVIEW_SEVERITY_PROMPT = `${REVIEW_SEVERITY_RUBRIC}
- **confidence**: Integer 0-100 representing certainty that the finding is real and evidenced.`;
