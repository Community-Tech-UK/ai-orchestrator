import { z } from 'zod';
import type {
  CommandName,
  EventTier,
  ThinClientCommandResponse,
  ThinClientEvent,
  StateSubscribeResult,
} from '../../shared/types/thin-client-event.types';
import {
  getMainEventBus,
  type EventTransport,
  type MainEventBus,
} from './main-event-bus';

const EVENT_TIERS = ['lifecycle', 'output', 'status', 'interaction', 'control', 'infra'] as const;
const COMMAND_NAMES = [
  'instance:create',
  'instance:send-input',
  'instance:terminate',
  'instance:interrupt',
  'instance:hibernate',
  'instance:wake',
  'instance:list',
  'instance:respond-input',
  'instance:respond-action',
  'loop:start',
  'loop:pause',
  'loop:resume',
  'loop:cancel',
  'loop:intervene',
  'loop:accept-completion',
  'chat:list',
  'chat:get',
  'chat:create',
  'chat:send-message',
  'snapshot:take',
  'session:list-resumable',
  'state:subscribe',
  'state:resync',
] as const satisfies readonly CommandName[];
const DEFAULT_TIERS: EventTier[] = ['lifecycle', 'interaction'];
const DEFAULT_MAX_BUFFERED_BYTES = 1_000_000;
const WS_OPEN = 1;

const ThinClientCommandSchema = z.object({
  cmdId: z.string().min(1).max(200),
  cmd: z.enum(COMMAND_NAMES),
  payload: z.unknown().optional(),
});
type ParsedThinClientCommand = z.infer<typeof ThinClientCommandSchema>;

const StateSubscribePayloadSchema = z.object({
  ipcAuthToken: z.string().min(1),
  tiers: z.union([
    z.literal('all'),
    z.array(z.enum(EVENT_TIERS)).min(1),
  ]).optional(),
});
const StateAuthPayloadSchema = z.object({
  ipcAuthToken: z.string().min(1),
}).passthrough();

interface WebSocketLike {
  readyState: number;
  bufferedAmount?: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code: number, reason: string): void;
  on?(event: 'close' | 'error' | 'message', listener: (...args: unknown[]) => void): void;
}

export interface WsEventTransportOptions {
  eventBus?: MainEventBus;
  getIpcAuthToken: () => string;
  buildStateSnapshot: (seq: number) => unknown;
  executeCommand?: (
    cmd: Exclude<CommandName, 'state:subscribe' | 'state:resync'>,
    payload: unknown,
  ) => Promise<{ success: boolean; data?: unknown; error?: { code?: string; message: string; timestamp?: number } }>;
  maxBufferedBytes?: number;
}

export class WsEventTransport implements EventTransport {
  tiers: Set<EventTier> | 'all' = new Set<EventTier>();

  private readonly eventBus: MainEventBus;
  private readonly getIpcAuthToken: () => string;
  private readonly buildStateSnapshot: (seq: number) => unknown;
  private readonly executeCommand?: WsEventTransportOptions['executeCommand'];
  private readonly maxBufferedBytes: number;
  private registered = false;
  private authorized = false;

  constructor(
    private readonly socket: WebSocketLike,
    options: WsEventTransportOptions,
  ) {
    this.eventBus = options.eventBus ?? getMainEventBus();
    this.getIpcAuthToken = options.getIpcAuthToken;
    this.buildStateSnapshot = options.buildStateSnapshot;
    this.executeCommand = options.executeCommand;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.socket.on?.('close', () => this.dispose());
  }

  handleClientMessage(raw: unknown): boolean {
    const parsedRaw = parseRawMessage(raw);
    if (!isThinClientCommandCandidate(parsedRaw)) {
      return false;
    }

    const command = ThinClientCommandSchema.safeParse(parsedRaw);
    if (!command.success) {
      this.sendResponse({
        cmdId: extractCommandId(parsedRaw),
        success: false,
        error: {
          code: 'THIN_CLIENT_COMMAND_INVALID',
          message: command.error.issues.map((issue) => issue.message).join('; '),
          timestamp: Date.now(),
        },
      });
      return true;
    }

    if (command.data.cmd === 'state:subscribe') {
      this.handleSubscribe(command.data.cmdId, command.data.payload);
      return true;
    }

    if (command.data.cmd === 'state:resync') {
      this.handleResync(command.data.cmdId, command.data.payload);
      return true;
    }

    this.handleCommand(command.data);
    return true;
  }

  send(event: ThinClientEvent): void {
    if (!this.authorized || !isSocketOpen(this.socket)) {
      return;
    }
    if (
      event.tier === 'output'
      && (this.socket.bufferedAmount ?? 0) > this.maxBufferedBytes
    ) {
      return;
    }
    this.sendJson(event);
  }

  dispose(): void {
    if (!this.registered) {
      return;
    }
    this.eventBus.removeTransport(this);
    this.registered = false;
  }

  private handleSubscribe(cmdId: string, payload: unknown): void {
    const parsed = StateSubscribePayloadSchema.safeParse(payload);
    if (!parsed.success || parsed.data.ipcAuthToken !== this.getIpcAuthToken()) {
      this.sendResponse({
        cmdId,
        success: false,
        error: {
          code: 'THIN_CLIENT_AUTH_FAILED',
          message: 'Missing or invalid auth token for state:subscribe',
          timestamp: Date.now(),
        },
      });
      this.socket.close(4001, 'Unauthorized');
      return;
    }

    this.tiers = normalizeTiers(parsed.data.tiers);
    this.authorized = true;
    if (!this.registered) {
      this.eventBus.addTransport(this);
      this.registered = true;
    }
    this.sendResponse<StateSubscribeResult>({
      cmdId,
      success: true,
      data: { tiers: serializeTiers(this.tiers) },
    });
  }

  private handleResync(cmdId: string, payload: unknown): void {
    if (!this.authorized) {
      this.sendResponse({
        cmdId,
        success: false,
        error: {
          code: 'THIN_CLIENT_NOT_SUBSCRIBED',
          message: 'state:subscribe must succeed before state:resync',
          timestamp: Date.now(),
        },
      });
      return;
    }
    if (!this.payloadHasValidAuthToken(payload)) {
      this.sendUnauthorized(cmdId, 'state:resync');
      this.socket.close(4001, 'Unauthorized');
      return;
    }

    this.sendResponse({
      cmdId,
      success: true,
      data: this.buildStateSnapshot(this.eventBus.getSnapshotSeqForTransport(this)),
    });
  }

  private handleCommand(
    command: ParsedThinClientCommand,
  ): void {
    const cmd = command.cmd as Exclude<CommandName, 'state:subscribe' | 'state:resync'>;
    if (!this.payloadHasValidAuthToken(command.payload)) {
      this.sendUnauthorized(command.cmdId, command.cmd);
      this.socket.close(4001, 'Unauthorized');
      return;
    }

    if (!this.executeCommand) {
      this.sendUnimplemented(command.cmdId, cmd);
      return;
    }

    void this.executeCommand(cmd, command.payload)
      .then((response) => {
        this.sendResponse({
          cmdId: command.cmdId,
          success: response.success,
          ...(response.data !== undefined ? { data: response.data } : {}),
          ...(response.error
            ? {
                error: {
                  code: response.error.code ?? 'THIN_CLIENT_COMMAND_FAILED',
                  message: response.error.message,
                  timestamp: response.error.timestamp ?? Date.now(),
                },
              }
            : {}),
        });
      })
      .catch((error: unknown) => {
        this.sendResponse({
          cmdId: command.cmdId,
          success: false,
          error: {
            code: 'THIN_CLIENT_COMMAND_FAILED',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        });
      });
  }

  private payloadHasValidAuthToken(payload: unknown): boolean {
    return StateAuthPayloadSchema.safeParse(payload).data?.ipcAuthToken === this.getIpcAuthToken();
  }

  private sendUnauthorized(cmdId: string, cmd: string): void {
    this.sendResponse({
      cmdId,
      success: false,
      error: {
        code: 'THIN_CLIENT_AUTH_FAILED',
        message: `Missing or invalid auth token for ${cmd}`,
        timestamp: Date.now(),
      },
    });
  }

  private sendUnimplemented(cmdId: string, cmd: CommandName): void {
    this.sendResponse({
      cmdId,
      success: false,
      error: {
        code: 'THIN_CLIENT_COMMAND_EXECUTOR_UNAVAILABLE',
        message: `${cmd} cannot run because this thin-client transport was created without a command executor`,
        timestamp: Date.now(),
      },
    });
  }

  private sendResponse<T>(response: ThinClientCommandResponse<T>): void {
    this.sendJson(response);
  }

  private sendJson(value: unknown): void {
    if (!isSocketOpen(this.socket)) {
      return;
    }
    this.socket.send(JSON.stringify(value));
  }
}

function parseRawMessage(raw: unknown): unknown {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
    return raw;
  }
  try {
    return JSON.parse(raw.toString());
  } catch {
    return raw;
  }
}

function isThinClientCommandCandidate(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const cmd = (value as Record<string, unknown>)['cmd'];
  return typeof cmd === 'string' && (COMMAND_NAMES as readonly string[]).includes(cmd);
}

function extractCommandId(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return 'unknown';
  }
  const cmdId = (value as Record<string, unknown>)['cmdId'];
  return typeof cmdId === 'string' && cmdId.length > 0 ? cmdId : 'unknown';
}

function normalizeTiers(tiers: z.infer<typeof StateSubscribePayloadSchema>['tiers']): Set<EventTier> | 'all' {
  if (tiers === 'all') {
    return 'all';
  }
  return new Set<EventTier>(tiers ?? DEFAULT_TIERS);
}

function serializeTiers(tiers: Set<EventTier> | 'all'): EventTier[] | 'all' {
  return tiers === 'all' ? 'all' : [...tiers];
}

function isSocketOpen(socket: WebSocketLike): boolean {
  return socket.readyState === WS_OPEN;
}
