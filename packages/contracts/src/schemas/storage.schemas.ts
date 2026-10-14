import { z } from 'zod';
export const StorageCleanupTargetSchema = z.enum(['event-record', 'event-record-shrink', 'rlm-backups', 'session-records', 'activity-logs']);
export const StorageUsageRequestSchema = z.object({ force: z.boolean().optional() }).strict();
export const StoragePreviewCleanupRequestSchema = z.object({ target: StorageCleanupTargetSchema }).strict();
export const StorageRunCleanupRequestSchema = z.object({ target: StorageCleanupTargetSchema, previewId: z.string().min(1).max(100) }).strict();
