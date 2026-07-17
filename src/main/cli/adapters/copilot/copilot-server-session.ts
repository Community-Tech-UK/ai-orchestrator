/**
 * WS14 — lifecycle wrapper around one Copilot SDK client + session.
 *
 * Owns exactly one `CopilotClient` (which spawns the CLI runtime over stdio
 * from the SAME package tree the SDK was loaded from) and one session on it.
 * Session events are run through the pure mapper and handed to the adapter
 * as effects; the adapter decides how to emit them.
 *
 * Interrupt = `session.abort()` (the turn is cancelled, the session stays
 * valid). Dispose = unsubscribe + disconnect + client stop, each fail-soft so
 * teardown never wedges adapter termination.
 */

import { getLogger } from '../../../logging/logger';
import type {
  CopilotSdkClientLike,
  CopilotSdkSessionLike,
  LoadedCopilotSdk,
} from './copilot-sdk-loader';
import {
  mapCopilotServerEvent,
  type CopilotServerEvent,
  type MappedCopilotServerEffect,
} from './copilot-server-event-mapper';

const logger = getLogger('CopilotServerSession');

export interface CopilotServerSessionParams {
  sdk: LoadedCopilotSdk;
  workingDirectory?: string;
  model?: string;
  /** Resume an existing Copilot session id (multi-turn / restore). */
  resumeSessionId?: string;
  /**
   * Permission handler bridged to AIO's approval surface. Yolo callers pass
   * an approve-all handler; non-yolo callers surface the request. The SDK
   * calls this for every permission the runtime asks for.
   */
  onPermissionRequest: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Mapped session effects, in arrival order. */
  onEffect: (effect: MappedCopilotServerEffect) => void;
}

export class CopilotServerSession {
  private constructor(
    private readonly client: CopilotSdkClientLike,
    private readonly session: CopilotSdkSessionLike,
    private readonly unsubscribe: () => void,
  ) {}

  /** The Copilot-side session id (used for --resume interop and restore). */
  get copilotSessionId(): string | null {
    return this.session.sessionId ?? null;
  }

  static async start(params: CopilotServerSessionParams): Promise<CopilotServerSession> {
    const client = new params.sdk.CopilotClient({
      // Pin the runtime to the exact binary tree the SDK came from — this is
      // the version-skew guard that killed the old standalone-SDK adapter.
      connection: { kind: 'stdio', path: params.sdk.cliPath },
      ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
      logLevel: 'none',
    });

    const sessionConfig: Record<string, unknown> = {
      streaming: true,
      onPermissionRequest: params.onPermissionRequest,
      ...(params.model ? { model: params.model } : {}),
      ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
    };

    let session: CopilotSdkSessionLike;
    try {
      session = params.resumeSessionId
        ? await client.resumeSession(params.resumeSessionId, sessionConfig)
        : await client.createSession(sessionConfig);
    } catch (error) {
      // Session setup failed — never leak the spawned runtime.
      await client.stop().catch(() => undefined);
      throw error;
    }

    const unsubscribe = session.on((event) => {
      try {
        params.onEffect(mapCopilotServerEvent(event as CopilotServerEvent));
      } catch (error) {
        logger.warn('Copilot server event handler failed', {
          eventType: (event as { type?: string }).type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return new CopilotServerSession(client, session, unsubscribe);
  }

  /** Send a prompt; resolves when the SDK acknowledges the turn submission. */
  async send(prompt: string): Promise<void> {
    await this.session.send({ prompt });
  }

  /** Cancel the in-flight turn; the session remains valid for the next send. */
  async abort(): Promise<void> {
    await this.session.abort();
  }

  /** Tear everything down, fail-soft per step. */
  async dispose(): Promise<void> {
    try {
      this.unsubscribe();
    } catch {
      /* listener already gone */
    }
    try {
      await this.session.disconnect();
    } catch (error) {
      logger.debug('Copilot session disconnect failed during dispose', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await this.client.stop();
    } catch (error) {
      logger.debug('Copilot client stop failed during dispose', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
