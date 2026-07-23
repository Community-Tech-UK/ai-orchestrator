import type { JsonRpcRequest } from './app-server-types';

const ELICITATION_PREFIX = 'codex_mcp_elicitation:';

export interface CodexMcpInputRequired {
  id: string;
  prompt: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

export interface CodexMcpElicitationBridgeOptions {
  onInputRequired: (payload: CodexMcpInputRequired) => void;
  onStatus: (status: 'busy' | 'waiting_for_permission') => void;
}

interface PendingElicitation {
  key: string;
  resolve: (result: McpElicitationResponse) => void;
}

interface McpElicitationResponse {
  action: 'accept' | 'decline' | 'cancel';
  content: unknown | null;
  _meta: Record<string, unknown> | null;
}

export class CodexMcpElicitationBridge {
  private readonly pending = new Map<string, PendingElicitation>();

  constructor(private readonly options: CodexMcpElicitationBridgeOptions) {}

  handleRequest(request: JsonRpcRequest): Promise<unknown> | undefined {
    if (request.method !== 'mcpServer/elicitation/request') return undefined;
    const params = request.params;
    const meta = asRecord(params['_meta']) ?? asRecord(params['meta']);
    const isToolApproval = meta?.['codex_approval_kind'] === 'mcp_tool_call';
    if (!isToolApproval || !isEmptyObjectSchema(params['requestedSchema'])) {
      return Promise.resolve({
        action: 'decline',
        content: null,
        _meta: {
          message: 'Harness cannot render this MCP elicitation form.',
        },
      } satisfies McpElicitationResponse);
    }

    const key = requestKey(request.id);
    return new Promise<McpElicitationResponse>((resolve) => {
      this.pending.set(key, { key, resolve });
      const serverName = typeof params['serverName'] === 'string'
        ? params['serverName']
        : 'unknown';
      const toolName = typeof meta?.['tool_name'] === 'string'
        ? meta['tool_name']
        : undefined;
      const message = typeof params['message'] === 'string'
        ? params['message']
        : 'Codex requests approval for an MCP tool call.';
      this.options.onStatus('waiting_for_permission');
      this.options.onInputRequired({
        id: key,
        prompt: message,
        timestamp: Date.now(),
        metadata: {
          type: 'codex_mcp_approval',
          transport: 'codex-app-server',
          serverName,
          toolName,
          approvalTraceId: `codex-app-server-${String(request.id)}`,
        },
      });
    });
  }

  respond(response: string, permissionKey?: string): void {
    const pending = this.resolvePending(permissionKey);
    if (!pending) {
      throw new Error('No pending Codex MCP approval request is waiting for a response.');
    }

    this.pending.delete(pending.key);
    const normalized = response.trim().toLowerCase();
    const denied = normalized.includes('denied')
      || normalized.includes('deny')
      || normalized.includes('decline')
      || normalized.includes('reject')
      || normalized === 'no';
    pending.resolve({
      action: denied ? 'decline' : 'accept',
      content: null,
      _meta: null,
    });
    this.options.onStatus('busy');
  }

  cancelRequest(requestId: number | string): void {
    const key = requestKey(requestId);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    pending.resolve({ action: 'cancel', content: null, _meta: null });
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) {
      pending.resolve({ action: 'cancel', content: null, _meta: null });
    }
    this.pending.clear();
  }

  private resolvePending(permissionKey?: string): PendingElicitation | undefined {
    if (permissionKey) {
      const direct = this.pending.get(permissionKey);
      if (direct) return direct;
      const prefixed = this.pending.get(`${ELICITATION_PREFIX}${permissionKey}`);
      if (prefixed) return prefixed;
    }
    if (this.pending.size === 1) return this.pending.values().next().value;
    return undefined;
  }
}

function requestKey(id: number | string): string {
  return `${ELICITATION_PREFIX}${String(id)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isEmptyObjectSchema(value: unknown): boolean {
  const schema = asRecord(value);
  if (!schema || schema['type'] !== 'object') return false;
  const properties = asRecord(schema['properties']);
  return properties !== null && Object.keys(properties).length === 0;
}
