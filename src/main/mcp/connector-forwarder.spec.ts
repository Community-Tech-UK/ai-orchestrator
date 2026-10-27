import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OrchestratorToolsRpcClient } from './orchestrator-tools-rpc-client';
import { afterEach, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ConnectorForwarder } from './connector-forwarder';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
describe('connector streaming HTTP relay', () => {
  it('relays tools, resources and prompts through the SDK and refreshes a rejected credential', async () => {
    const server = new Server(
      { name: 'fixture', version: '1' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => ({
      content: [{ type: 'text', text: String(req.params.arguments?.['value']) }],
    }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: 'fixture://one', name: 'one' }],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async () => ({
      contents: [{ uri: 'fixture://one', text: 'resource proof' }],
    }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{ name: 'greeting' }],
    }));
    server.setRequestHandler(GetPromptRequestSchema, async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'prompt proof' } }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => 'fixture-session',
    });
    await server.connect(transport);
    cleanups.push(() => server.close());
    let sawRefresh = false;
    const listener = http.createServer(async (req, res) => {
      if (req.headers.authorization !== 'Bearer PLACEHOLDER_CURRENT') {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('fixture not listening');
    const forwarder = new ConnectorForwarder('example', {
      call: async (method, payload) => {
        expect(method).toBe('connectors.connection');
        expect(payload['name']).toBe('example');
        if (payload['forceRefresh']) sawRefresh = true;
        return {
          kind: 'remote',
          url: `http://127.0.0.1:${address.port}/mcp`,
          accessToken: sawRefresh ? 'PLACEHOLDER_CURRENT' : 'PLACEHOLDER_EXPIRED',
        };
      },
    });
    cleanups.push(() => forwarder.close());
    expect(await forwarder.dispatch('tools/list')).toMatchObject({ tools: [{ name: 'echo' }] });
    expect(sawRefresh).toBe(true);
    expect(
      await forwarder.dispatch('tools/call', { name: 'echo', arguments: { value: 'relay proof' } }),
    ).toMatchObject({ content: [{ text: 'relay proof' }] });
    expect(await forwarder.dispatch('resources/list')).toMatchObject({
      resources: [{ uri: 'fixture://one' }],
    });
    expect(await forwarder.dispatch('resources/read', { uri: 'fixture://one' })).toMatchObject({
      contents: [{ text: 'resource proof' }],
    });
    expect(await forwarder.dispatch('prompts/list')).toMatchObject({
      prompts: [{ name: 'greeting' }],
    });
    expect(await forwarder.dispatch('prompts/get', { name: 'greeting' })).toMatchObject({
      messages: [{ content: { text: 'prompt proof' } }],
    });
  });
  it('closes a pending Graph RPC when the tool caller cancels', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-relay-abort-'));
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\connector-relay-${Date.now()}`
        : path.join(directory, 'rpc.sock');
    cleanups.push(async () => {
      fs.rmSync(directory, { recursive: true, force: true });
    });
    let arrived!: () => void;
    const graphRequest = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let disconnected!: () => void;
    const graphClosed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer.split('\n')[0]);
        if (request.method === 'connectors.connection')
          socket.end(
            JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { kind: 'microsoft365' } }) +
              '\n',
          );
        else {
          socket.once('close', () => disconnected());
          arrived();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const rpc = new OrchestratorToolsRpcClient({
      env: {
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: socketPath,
        AI_ORCHESTRATOR_INSTANCE_ID: 'fixture',
        AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY: 'PLACEHOLDER_CAPABILITY',
      },
      timeoutMs: 1000,
    });
    const relay = new ConnectorForwarder('example', rpc);
    cleanups.push(() => relay.close());
    const controller = new AbortController();
    const pending = relay.dispatch(
      'tools/call',
      { name: 'graph_mail_send', arguments: { messageId: 'fixture' } },
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await graphRequest;
    controller.abort();
    await rejected;
    await graphClosed;
  });
});
