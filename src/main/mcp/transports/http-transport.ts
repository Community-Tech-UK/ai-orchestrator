import { EventEmitter } from 'node:events';

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpTransport extends EventEmitter {
  private connected = false;
  private abortController: AbortController | null = null;

  constructor(private readonly options: HttpTransportOptions) {
    super();
  }

  async connect(): Promise<void> {
    if (!this.options.url) {
      throw new Error('HTTP transport requires a url');
    }
    this.connected = true;
    this.abortController = new AbortController();
  }

  async send(message: unknown): Promise<void> {
    if (!this.connected) {
      throw new Error('HTTP transport is not connected');
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('HTTP MCP request timed out')),
        this.options.timeoutMs ?? 30_000,
      );
    });

    try {
      const response = await Promise.race([
        fetch(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...this.options.headers,
        },
        body: JSON.stringify(message),
        }),
        timeoutPromise,
      ]);
      if (!response.ok) {
        throw new Error(`HTTP MCP request failed: ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      if (text.trim()) {
        this.emit('message', JSON.parse(text));
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.abortController?.abort();
    this.abortController = null;
    this.emit('disconnected');
  }
}
