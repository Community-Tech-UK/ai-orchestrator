/**
 * A fake Linear connector for tests: a real MCP server on 127.0.0.1 with scripted tools, so the real client, token
 * handling and redirect rules run exactly as they do against Linear. No test that uses it needs the network.
 *
 * Each HTTP request gets its own server (the SDK's stateless mode), because the code under test opens a fresh
 * connection per call. Every request is recorded, so a test can prove what was and was not sent. Tokens in tests are
 * obvious placeholders.
 */
import * as http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';
import { checkLinearConnectorRecord, type LinearRecordCheck } from './linear-connector-address';

export interface FakeToolReply {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
/** A reply, or `'hang'` for a tool that never answers. */
export type FakeToolResult = FakeToolReply | 'hang';
export type FakeToolHandler = (args: Record<string, unknown>) => FakeToolResult | Promise<FakeToolResult>;

/** A result carrying JSON as text, the way the real connector sends its lists. */
export function jsonText(value: unknown): FakeToolReply {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
/** A result carrying the answer as structured content. */
export function structured(value: Record<string, unknown>): FakeToolReply {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
export function plainText(text: string): FakeToolReply {
  return { content: [{ type: 'text', text }] };
}
export function toolError(text: string): FakeToolReply {
  return { content: [{ type: 'text', text }], isError: true };
}

export interface FakeRequestRecord {
  method: string;
  authorization: string | undefined;
}

export interface FakeLinearConnectorOptions {
  tools: Record<string, FakeToolHandler>;
  /** Requests carrying any other token get a 401. Leave out to accept any request. */
  acceptedToken?: string;
  /** Answer every request with a redirect to this address. */
  redirectTo?: string;
  /** Answer every request with this status and body instead of serving it. */
  failWith?: { status: number; body: string };
}

export interface FakeLinearConnector {
  /** The address to put on a connector record. */
  url: string;
  requests: FakeRequestRecord[];
  /** The tool calls received, in order. */
  calls: { name: string; args: Record<string, unknown> }[];
  close(): Promise<void>;
}

export async function startFakeLinearConnector(options: FakeLinearConnectorOptions): Promise<FakeLinearConnector> {
  const requests: FakeRequestRecord[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const hanging = new Set<() => void>();
  const listener = http.createServer(async (req, res) => {
    requests.push({ method: req.method ?? '', authorization: req.headers.authorization });
    let body = '';
    for await (const chunk of req) body += chunk;
    if (options.redirectTo) {
      res.writeHead(307, { location: options.redirectTo });
      res.end();
      return;
    }
    if (options.failWith) {
      res.writeHead(options.failWith.status, { 'content-type': 'text/plain' });
      res.end(options.failWith.body);
      return;
    }
    if (options.acceptedToken && req.headers.authorization !== `Bearer ${options.acceptedToken}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const server = new Server({ name: 'fake-linear', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.keys(options.tools).map((name) => ({ name, inputSchema: { type: 'object' as const } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const args = (call.params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ name: call.params.name, args });
      const handler = options.tools[call.params.name];
      if (!handler) return toolError('Unknown tool');
      const result = await handler(args);
      if (result === 'hang') {
        await new Promise<void>((resolve) => hanging.add(resolve));
        return toolError('The fake connector was closed.');
      }
      return result;
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('The fake connector did not start.');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    calls,
    async close() {
      for (const release of hanging) release();
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

/** A record check that accepts the fake's own address and applies the real Linear rule to every other. */
export function acceptingFakeAddress(fake: Pick<FakeLinearConnector, 'url'>): (record: OrchestratorMcpServer) => LinearRecordCheck {
  return (record) =>
    record.url === fake.url && record.autoConnect
      ? { ok: true }
      : record.url === fake.url
        ? { ok: false, problem: 'off', reason: 'The connector is turned off.' }
        : checkLinearConnectorRecord(record);
}
