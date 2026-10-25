import { z } from 'zod';
import { PAUSE_CLI_METHODS, PauseCliStatusSchema } from './pause-cli';

export function isPauseCliRpcMethod(method: string): boolean {
  return Object.values(PAUSE_CLI_METHODS).some(value => value === method);
}

export async function dispatchPauseCliRpc(method: string, payload: Record<string, unknown>): Promise<unknown> {
  z.object({}).strict().parse(payload);
  const { getGlobalPauseService } = await import('../global-pause/global-pause-service');
  const service = getGlobalPauseService();
  switch (method) {
    case PAUSE_CLI_METHODS.status: break;
    case PAUSE_CLI_METHODS.hold: service.hold('Held by an agent'); break;
    case PAUSE_CLI_METHODS.release: service.release(); break;
    default: throw new Error('Unknown pause command');
  }
  // Strip note text and identities from CLI output.
  const { phase, since, reason } = service.getState();
  return PauseCliStatusSchema.parse({ phase, since, reason });
}
