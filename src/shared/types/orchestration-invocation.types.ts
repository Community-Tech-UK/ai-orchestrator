import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const OptionalNonEmptyStringSchema = z.string().min(1).optional();

function functionSchema<T extends (...args: any[]) => unknown>(name: string): z.ZodType<T> {
  return z.custom<T>((value) => typeof value === 'function', {
    message: `${name} must be a function`,
  });
}

export interface InvocationTextResult {
  response: string;
  tokens: number;
  cost: number;
}

export const InvocationTextResultSchema = z.object({
  response: z.string(),
  tokens: z.number().int().nonnegative().default(0),
  cost: z.number().nonnegative().default(0),
});

export type InvocationTextResultOutput = z.output<typeof InvocationTextResultSchema>;

export function normalizeInvocationTextResult(
  result: Partial<InvocationTextResult>,
): InvocationTextResultOutput {
  return InvocationTextResultSchema.parse(result);
}

export type VerificationAgentInvocationCallback = (
  err: string | null,
  response?: string,
  tokens?: number,
  cost?: number,
) => void;

export const VerificationAgentInvocationPayloadSchema = z.object({
  correlationId: NonEmptyStringSchema,
  requestId: NonEmptyStringSchema,
  instanceId: OptionalNonEmptyStringSchema,
  agentId: NonEmptyStringSchema,
  model: OptionalNonEmptyStringSchema,
  systemPrompt: OptionalNonEmptyStringSchema,
  userPrompt: z.string(),
  context: z.string().optional(),
  callback: functionSchema<VerificationAgentInvocationCallback>('verification callback'),
});

export type VerificationAgentInvocationPayload = z.infer<
  typeof VerificationAgentInvocationPayloadSchema
>;

export type ReviewAgentInvocationCallback = VerificationAgentInvocationCallback;

export const ReviewAgentInvocationPayloadSchema = z.object({
  correlationId: NonEmptyStringSchema,
  reviewId: NonEmptyStringSchema,
  instanceId: OptionalNonEmptyStringSchema,
  agentId: NonEmptyStringSchema,
  model: OptionalNonEmptyStringSchema,
  systemPrompt: NonEmptyStringSchema,
  context: z.string(),
  userPrompt: z.string(),
  callback: functionSchema<ReviewAgentInvocationCallback>('review callback'),
});

export type ReviewAgentInvocationPayload = z.infer<typeof ReviewAgentInvocationPayloadSchema>;

export type DebateResponseInvocationCallback = (response: string, tokens: number) => void;
export type DebateTextInvocationCallback = (response: string) => void;

const DebateInvocationBaseSchema = z.object({
  correlationId: NonEmptyStringSchema,
  debateId: NonEmptyStringSchema,
  instanceId: OptionalNonEmptyStringSchema,
  provider: OptionalNonEmptyStringSchema,
  agentId: NonEmptyStringSchema,
  agentIndex: z.number().int().nonnegative().optional(),
  model: OptionalNonEmptyStringSchema,
  systemPrompt: OptionalNonEmptyStringSchema,
  prompt: z.string(),
  context: z.string().optional(),
});

export const DebateResponseInvocationPayloadSchema = DebateInvocationBaseSchema.extend({
  temperature: z.number().finite().optional(),
  callback: functionSchema<DebateResponseInvocationCallback>('debate response callback'),
});

export type DebateResponseInvocationPayload = z.infer<
  typeof DebateResponseInvocationPayloadSchema
>;

export const DebateCritiqueInvocationPayloadSchema = DebateInvocationBaseSchema.extend({
  callback: functionSchema<DebateTextInvocationCallback>('debate critique callback'),
});

export type DebateCritiqueInvocationPayload = z.infer<
  typeof DebateCritiqueInvocationPayloadSchema
>;

export const DebateDefenseInvocationPayloadSchema = DebateInvocationBaseSchema.extend({
  callback: functionSchema<DebateTextInvocationCallback>('debate defense callback'),
});

export type DebateDefenseInvocationPayload = z.infer<
  typeof DebateDefenseInvocationPayloadSchema
>;

export const DebateSynthesisInvocationPayloadSchema = DebateInvocationBaseSchema.extend({
  callback: functionSchema<DebateTextInvocationCallback>('debate synthesis callback'),
});

export type DebateSynthesisInvocationPayload = z.infer<
  typeof DebateSynthesisInvocationPayloadSchema
>;

export type WorkflowAgentInvocationCallback = (response: string, tokens: number) => void;

export const WorkflowAgentInvocationPayloadSchema = z.object({
  correlationId: NonEmptyStringSchema,
  executionId: NonEmptyStringSchema,
  agentId: NonEmptyStringSchema,
  agentType: NonEmptyStringSchema,
  model: OptionalNonEmptyStringSchema,
  prompt: z.string(),
  callback: functionSchema<WorkflowAgentInvocationCallback>('workflow callback'),
});

export type WorkflowAgentInvocationPayload = z.infer<
  typeof WorkflowAgentInvocationPayloadSchema
>;
