import type { IncomingMessage, ServerResponse } from 'http';
import type {
  MobileHistoryContinueResponse,
  MobileWakeResponse,
} from '../../shared/types/mobile-gateway.types';
import { HISTORY_CHAT_PREFIX, HISTORY_INSTANCE_PREFIX } from './mobile-gateway-history-handlers';
import { MobileRouteError, sendJsonResponse } from './mobile-gateway-http-utils';

export interface GatewayHistoryContinueSource {
  restore(entryId: string): Promise<MobileHistoryContinueResponse>;
  wake(instanceId: string): Promise<void>;
}

function historyRestoreId(id: string): string {
  if (id.startsWith(HISTORY_CHAT_PREFIX)) {
    throw new MobileRouteError('Chat history cannot be continued from the phone. Open it on your Mac.', 409);
  }
  if (id.startsWith(HISTORY_INSTANCE_PREFIX)) {
    const entryId = id.slice(HISTORY_INSTANCE_PREFIX.length).trim();
    if (!entryId) throw new MobileRouteError('A valid history id is required');
    return entryId;
  }
  return id;
}

function decodeId(raw: string, label: string): string {
  try {
    const id = decodeURIComponent(raw).trim();
    if (!id || id.length > 400) throw new Error('bad');
    return id;
  } catch {
    throw new MobileRouteError(`A valid ${label} is required`);
  }
}

export class MobileGatewayHistoryContinueHandlers {
  constructor(private readonly deps: { getSource(): GatewayHistoryContinueSource }) {}

  async handle(_req: IncomingMessage, res: ServerResponse, segments: string[], method: string): Promise<boolean> {
    if (method !== 'POST') return false;
    if (segments[1] === 'history' && segments.length === 4 && segments[3] === 'continue') {
      const restored = await this.deps.getSource().restore(historyRestoreId(decodeId(segments[2], 'history id')));
      sendJsonResponse(res, 200, restored);
      return true;
    }
    if (segments[1] === 'instances' && segments.length === 4 && segments[3] === 'wake') {
      await this.deps.getSource().wake(decodeId(segments[2], 'instance id'));
      const body: MobileWakeResponse = { ok: true };
      sendJsonResponse(res, 200, body);
      return true;
    }
    return false;
  }
}
