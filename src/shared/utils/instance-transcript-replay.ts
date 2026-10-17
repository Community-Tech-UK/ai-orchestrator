import { z } from 'zod';
import { FileAttachmentSchema } from '@contracts/schemas/common';
import { ImageResolveFailureReasonSchema, ImageResolveKindSchema } from '@contracts/schemas/image';
import type { OutputMessage } from '../types/instance.types';

const counter = z.number().int().nonnegative().safe();
export const TranscriptReplayIdentitySchema = z.object({
  kind: z.literal('history-replay'), instanceId: z.string().min(1).max(200),
  createdAt: z.number().finite().nonnegative(), adapterGeneration: counter, restartEpoch: counter,
  revision: counter.positive(),
});
const MessageSchema = z.object({
  id: z.string().min(1), timestamp: z.number().finite(),
  type: z.enum(['assistant', 'user', 'system', 'tool_use', 'tool_result', 'error']), content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(FileAttachmentSchema.extend({ data: z.string() })).optional(),
  failedImages: z.array(z.object({ src: z.string(), kind: ImageResolveKindSchema,
    reason: ImageResolveFailureReasonSchema, message: z.string(), origin: z.enum(['markdown', 'bare']).optional() })).optional(),
  thinking: z.array(z.object({ id: z.string(), content: z.string(),
    format: z.enum(['structured', 'xml', 'bracket', 'header', 'sdk', 'unknown']),
    timestamp: z.number().finite().optional(), tokenCount: z.number().finite().optional() })).optional(),
  thinkingExtracted: z.boolean().optional(),
});
export interface InstanceTranscriptReplay extends z.infer<typeof TranscriptReplayIdentitySchema> { messages: OutputMessage[] }
export function parseInstanceTranscriptReplay(value: unknown): InstanceTranscriptReplay {
  return TranscriptReplayIdentitySchema.extend({ messages: z.array(MessageSchema).max(20_000) }).parse(value);
}
