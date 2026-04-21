import { BaseCliAdapter, CliAdapterConfig, CliCapabilities, CliMessage, CliResponse, CliStatus } from './base-cli-adapter';
import type { FileAttachment } from '../../../shared/types/instance.types';

export interface CursorCliConfig {
  model?: string;
  workingDir?: string;
  systemPrompt?: string;
  yoloMode?: boolean;
  timeout?: number;
}

export class CursorCliAdapter extends BaseCliAdapter {
  private cliConfig: CursorCliConfig;

  constructor(config: CursorCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      command: 'cursor-agent',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout ?? 300_000,
      sessionPersistence: true,
    };
    super(adapterConfig);
    this.cliConfig = { ...config };
    this.sessionId = `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  getName(): string { return 'cursor-cli'; }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: false,
      codeExecution: true,
      contextWindow: 200_000,
      outputFormats: ['text', 'json', 'stream-json'],
    };
  }

  async checkStatus(): Promise<CliStatus> {
    return { available: false, error: 'stub: implement in Phase 4' };
  }

  async sendMessage(_message: CliMessage): Promise<CliResponse> {
    void _message;
    throw new Error('CursorCliAdapter: stub — not yet implemented');
  }

  async *sendMessageStream(_message: CliMessage): AsyncIterable<string> {
    void _message;
    throw new Error('CursorCliAdapter: stub — not yet implemented');
    yield ''; // unreachable; required by the `require-yield` lint rule on generator functions
  }

  parseOutput(_raw: string): CliResponse {
    void _raw;
    throw new Error('CursorCliAdapter: stub — not yet implemented');
  }

  protected buildArgs(_message: CliMessage): string[] {
    void _message;
    throw new Error('CursorCliAdapter: stub — not yet implemented');
  }

  // ============ InstanceManager Compatibility API ============

  /**
   * Stub spawn — will be implemented in Phase 4.
   */
  async spawn(): Promise<number> {
    throw new Error('CursorCliAdapter: stub — not yet implemented');
  }

  /**
   * Stub sendInput — will be implemented in Phase 4.
   */
  async sendInput(_message: string, _attachments?: FileAttachment[]): Promise<void> {
    void _message;
    void _attachments;
    throw new Error('CursorCliAdapter: stub — not yet implemented');
  }
}
