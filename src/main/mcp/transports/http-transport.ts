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
    let removeAbortListener = (): void => {};
    const controller = this.abortController;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('HTTP MCP request timed out')),
        this.options.timeoutMs ?? 30_000,
      );
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (!controller) {
        return;
      }
      const onAbort = () => reject(new Error('HTTP MCP request aborted'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
    });
    const signal = compatibleFetchSignal(controller?.signal);

    try {
      const fetchPromise = fetch(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...this.options.headers,
        },
        body: JSON.stringify(message),
        ...(signal ? { signal } : {}),
      }).catch((error) => {
        if (controller?.signal.aborted) {
          return new Promise<Response>(() => { /* abort race already rejected */ });
        }
        throw error;
      });
      const response = await Promise.race([
        fetchPromise,
        timeoutPromise,
        abortPromise,
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
      removeAbortListener();
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.abortController?.abort();
    this.abortController = null;
    this.emit('disconnected');
  }
}

function compatibleFetchSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
  if (!signal) {
    return undefined;
  }
  try {
    new Request('http://127.0.0.1/', { signal });
    return signal;
  } catch {
    return undefined;
  }
}
