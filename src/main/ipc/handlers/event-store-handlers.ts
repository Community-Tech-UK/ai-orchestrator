/**
 * Event Store IPC Handlers
 *
 * Exposes the OrchestrationEventStore query methods to the renderer process
 * via IPC channels.
 */

import { ipcMain } from 'electron';
import { z } from 'zod';
import { getLogger } from '../../logging/logger';

const logger = getLogger('EventStoreHandlers');

const AggregateIdSchema = z.string().min(1).max(200);
const EventTypeSchema = z.string().min(1).max(200);
const LimitSchema = z.number().int().min(1).max(10_000).optional();

export interface EventStoreHandlerDeps {
  getByAggregateId: (aggregateId: string) => unknown[];
  getByType: (type: string, limit?: number) => unknown[];
  getRecentEvents: (limit?: number) => unknown[];
}

export function registerEventStoreHandlers(deps: EventStoreHandlerDeps): void {
  ipcMain.handle('events:by-aggregate', (_event, aggregateId: unknown) => {
    const id = AggregateIdSchema.parse(aggregateId);
    return deps.getByAggregateId(id);
  });

  ipcMain.handle('events:by-type', (_event, type: unknown, limit?: unknown) => {
    const validatedType = EventTypeSchema.parse(type);
    const validatedLimit = LimitSchema.parse(limit);
    return deps.getByType(validatedType, validatedLimit);
  });

  ipcMain.handle('events:recent', (_event, limit?: unknown) => {
    const validatedLimit = LimitSchema.parse(limit);
    return deps.getRecentEvents(validatedLimit);
  });

  logger.info('Event store IPC handlers registered');
}

export function unregisterEventStoreHandlers(): void {
  ipcMain.removeHandler('events:by-aggregate');
  ipcMain.removeHandler('events:by-type');
  ipcMain.removeHandler('events:recent');
}
