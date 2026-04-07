import { z } from 'zod/v4';

export const FsReadDirectoryParamsSchema = z.object({
  path: z.string().min(1).max(4096),
  depth: z.number().int().min(1).max(3).default(1),
  includeHidden: z.boolean().default(false),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(1000).default(500),
});

export const FsStatParamsSchema = z.object({
  path: z.string().min(1).max(4096),
});

export const FsSearchParamsSchema = z.object({
  query: z.string().min(1).max(200),
  maxResults: z.number().int().min(1).max(100).default(20),
});

export const FsWatchParamsSchema = z.object({
  path: z.string().min(1).max(4096),
  recursive: z.boolean().default(false),
});

export const FsUnwatchParamsSchema = z.object({
  watchId: z.string().min(1).max(100),
});

export const FsEventParamsSchema = z.object({
  watchId: z.string(),
  events: z.array(z.object({
    type: z.enum(['add', 'change', 'delete']),
    path: z.string(),
    isDirectory: z.boolean(),
  })),
});
