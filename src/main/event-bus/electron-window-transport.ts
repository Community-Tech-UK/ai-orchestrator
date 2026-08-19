import { getLogger } from '../logging/logger';
import type { ThinClientEvent } from '../../shared/types/thin-client-event.types';
import type { EventTransport } from './main-event-bus';
import { validateRendererEventPayload } from './renderer-event-validation';

const logger = getLogger('ElectronWindowTransport');

interface ElectronWebContentsLike {
  isDestroyed?: () => boolean;
  send: (channel: string, ...args: unknown[]) => void;
}

export class ElectronWindowTransport implements EventTransport {
  readonly tiers = 'all' as const;

  constructor(private readonly getWebContents: () => ElectronWebContentsLike | null | undefined) {}

  send(event: ThinClientEvent, rendererArgs?: readonly unknown[]): void {
    const webContents = this.getWebContents();
    if (!webContents) {
      // LT-diagnostic (2026-08-18): this early return was previously unlogged,
      // which made it impossible to distinguish "no window yet" from a schema
      // rejection or a delivery that never happened at all.
      logger.debug('Dropped renderer event: no webContents', { channel: event.type });
      return;
    }
    if (webContents.isDestroyed?.()) {
      logger.debug('Dropped renderer event: webContents destroyed', { channel: event.type });
      return;
    }
    if (!validateRendererEventPayload(event.type, event.payload)) {
      return;
    }
    webContents.send(event.type, ...(rendererArgs ?? [event.payload]));
  }
}
