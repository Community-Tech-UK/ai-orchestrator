import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { getLogger } from '../logging/logger';
import type {
  LspWorkerRequest,
  LspWorkerResponse,
} from './protocol';

const logger = getLogger('LspWorkerGateway');

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface LspWorkerGatewayOptions {
  requestTimeoutMs?: number;
  workerFactory?: () => Worker;
}

export class LspWorkerGateway extends EventEmitter {
  private readonly requestTimeoutMs: number;
  private readonly workerFactory?: () => Worker;
  private worker: Worker | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();

  constructor(options: LspWorkerGatewayOptions = {}) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.workerFactory = options.workerFactory;
  }

  async start(): Promise<void> {
    if (this.worker) {
      return;
    }

    const worker = this.workerFactory?.() ?? this.createWorker();
    worker.on('message', (message: unknown) => this.handleMessage(message as LspWorkerResponse));
    worker.on('error', (error) => {
      logger.error('LSP worker crashed', error);
      this.failAllPending(error);
      this.worker = null;
      this.emit('worker:error', error);
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        const error = new Error(`LSP worker exited with code ${code}`);
        this.failAllPending(error);
        this.emit('worker:error', error);
      }
      this.worker = null;
      this.emit('worker:exit', code);
    });

    this.worker = worker;
    await this.ping();
  }

  async stop(): Promise<void> {
    if (!this.worker) {
      return;
    }

    try {
      await this.send('shutdown', {});
    } catch {
      // Best-effort shutdown only.
    }

    const worker = this.worker;
    this.worker = null;
    await worker.terminate();
  }

  async ping(): Promise<unknown> {
    return this.send('ping', {});
  }

  async ready(workspacePath: string, language: string, timeoutMs = 15_000): Promise<{ ready: boolean; filePath: string | null }> {
    return this.send('warm-workspace', { workspacePath, language }, timeoutMs) as Promise<{
      ready: boolean;
      filePath: string | null;
    }>;
  }

  async getAvailableServers(): Promise<unknown> {
    return this.send('get-available-servers', {});
  }

  async getStatus(): Promise<unknown> {
    return this.send('get-status', {});
  }

  async isAvailableForFile(filePath: string): Promise<unknown> {
    return this.send('is-available-for-file', { filePath });
  }

  async goToDefinition(filePath: string, line: number, character: number): Promise<unknown> {
    return this.send('go-to-definition', { filePath, line, character });
  }

  async findReferences(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<unknown> {
    return this.send('find-references', { filePath, line, character, includeDeclaration });
  }

  async hover(filePath: string, line: number, character: number): Promise<unknown> {
    return this.send('hover', { filePath, line, character });
  }

  async getDocumentSymbols(filePath: string): Promise<unknown> {
    return this.send('document-symbols', { filePath });
  }

  async workspaceSymbols(query: string, rootPath: string): Promise<unknown> {
    return this.send('workspace-symbols', { query, rootPath });
  }

  async getDiagnostics(filePath: string): Promise<unknown> {
    return this.send('diagnostics', { filePath });
  }

  async findImplementations(filePath: string, line: number, character: number): Promise<unknown> {
    return this.send('find-implementations', { filePath, line, character });
  }

  async getIncomingCalls(filePath: string, line: number, character: number): Promise<unknown> {
    return this.send('incoming-calls', { filePath, line, character });
  }

  async getOutgoingCalls(filePath: string, line: number, character: number): Promise<unknown> {
    return this.send('outgoing-calls', { filePath, line, character });
  }

  async send<T extends LspWorkerRequest['type']>(
    type: T,
    payload: Extract<LspWorkerRequest, { type: T }>['payload'],
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    await this.start();

    if (!this.worker) {
      throw new Error('LSP worker is not available');
    }

    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP worker request timed out: ${type}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.worker?.postMessage({ id, type, payload });
    });
  }

  private handleMessage(message: LspWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    pending.reject(new Error(message.error ?? 'LSP worker request failed'));
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private createWorker(): Worker {
    const jsEntry = path.join(__dirname, 'worker-main.js');
    if (existsSync(jsEntry)) {
      return new Worker(jsEntry);
    }

    const tsEntry = path.join(__dirname, 'worker-main.ts');
    if (existsSync(tsEntry)) {
      return new Worker(tsEntry, {
        execArgv: ['--import', 'tsx'],
      });
    }

    throw new Error(`Unable to locate LSP worker entrypoint in ${__dirname}`);
  }
}
