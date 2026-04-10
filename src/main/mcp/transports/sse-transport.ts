/**
 * SSE Transport - Server-Sent Events transport for MCP
 *
 * Implements the MCP SSE transport protocol:
 * - Connects to an SSE endpoint to receive JSON-RPC responses/notifications
 * - Sends JSON-RPC requests via HTTP POST to a message endpoint
 * - The SSE stream may include an `endpoint` event advertising the POST URL
 */

import { EventEmitter } from 'events';
import { getLogger } from '../../logging/logger';

const logger = getLogger('SseTransport');

export interface SseTransportConfig {
  url: string;
  headers?: Record<string, string>;
}

export class SseTransport extends EventEmitter {
  private config: SseTransportConfig;
  private abortController: AbortController | null = null;
  private messageEndpoint: string | null = null;
  private connected = false;

  constructor(config: SseTransportConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    this.abortController = new AbortController();
    const response = await fetch(this.config.url, {
      headers: {
        Accept: 'text/event-stream',
        ...this.config.headers,
      },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('SSE response has no body');
    }

    this.connected = true;
    this.emit('connected');

    // Read the SSE stream asynchronously
    this.readStream(response.body).catch(err => {
      if (!this.abortController?.signal.aborted) {
        logger.error('SSE stream error', err instanceof Error ? err : undefined);
        this.emit('error', err);
      }
    });
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = 'message';
    let data = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            data += line.slice(5).trim();
          } else if (line === '') {
            // Empty line signals end of event
            if (data) {
              this.handleEvent(eventType, data);
              eventType = 'message';
              data = '';
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
      this.connected = false;
      this.emit('disconnected');
    }
  }

  private handleEvent(eventType: string, data: string): void {
    if (eventType === 'endpoint') {
      // Server advertises the POST endpoint for sending messages
      this.messageEndpoint = data;
      logger.info(`SSE message endpoint: ${this.messageEndpoint}`);
      return;
    }

    try {
      const message = JSON.parse(data) as unknown;
      this.emit('message', message);
    } catch {
      logger.warn(`Failed to parse SSE message: ${data.slice(0, 100)}`);
    }
  }

  async send(message: unknown): Promise<void> {
    const endpoint = this.messageEndpoint ?? new URL('/message', this.config.url).href;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers,
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`SSE send failed: ${response.status}`);
    }
  }

  disconnect(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.connected = false;
    this.messageEndpoint = null;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
