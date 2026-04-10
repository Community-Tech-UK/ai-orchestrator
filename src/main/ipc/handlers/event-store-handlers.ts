/**
 * Event Store IPC Handlers
 *
 * Exposes the OrchestrationEventStore query methods to the renderer process
 * via IPC channels.
 */

import { ipcMain } from 'electron';
import { getLogger } from '../../logging/logger';

const logger = getLogger('EventStoreHandlers');

export interface EventStoreHandlerDeps {
  getByAggregateId: (aggregateId: string) => unknown[];
  getByType: (type: string, limit?: number) => unknown[];
  getRecentEvents: (limit?: number) => unknown[];
}

export function registerEventStoreHandlers(deps: EventStoreHandlerDeps): void {
  ipcMain.handle('events:by-aggregate', (_event, aggregateId: string) => {
    return deps.getByAggregateId(aggregateId);
  });

  ipcMain.handle('events:by-type', (_event, type: string, limit?: number) => {
    return deps.getByType(type, limit);
  });

  ipcMain.handle('events:recent', (_event, limit?: number) => {
    return deps.getRecentEvents(limit);
  });

  logger.info('Event store IPC handlers registered');
}

export function unregisterEventStoreHandlers(): void {
  ipcMain.removeHandler('events:by-aggregate');
  ipcMain.removeHandler('events:by-type');
  ipcMain.removeHandler('events:recent');
}
