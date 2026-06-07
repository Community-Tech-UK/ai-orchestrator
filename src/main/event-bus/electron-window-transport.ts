import type { ThinClientEvent } from '../../shared/types/thin-client-event.types';
import type { EventTransport } from './main-event-bus';

interface ElectronWebContentsLike {
  isDestroyed?: () => boolean;
  send: (channel: string, ...args: unknown[]) => void;
}

export class ElectronWindowTransport implements EventTransport {
  readonly tiers = 'all' as const;

  constructor(private readonly getWebContents: () => ElectronWebContentsLike | null | undefined) {}

  send(event: ThinClientEvent, rendererArgs?: readonly unknown[]): void {
    const webContents = this.getWebContents();
    if (!webContents || webContents.isDestroyed?.()) {
      return;
    }
    webContents.send(event.type, ...(rendererArgs ?? [event.payload]));
  }
}
