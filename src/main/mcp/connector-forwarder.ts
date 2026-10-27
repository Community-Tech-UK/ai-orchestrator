import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';
import {
  CONNECTOR_RESULTS,
  connectRemoteConnector,
  type ConnectorMethod,
  type RemoteConnectorConnection,
} from './connector-remote-client';

const REQUESTS = [
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
] as const;
export class ConnectorForwarder {
  private client: Promise<Client> | null = null;
  private readonly lifetime = new AbortController();
  constructor(
    private readonly name: string,
    private readonly rpc: OrchestratorToolsRpcClientLike,
  ) {}
  async dispatch(
    method: ConnectorMethod,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const requestSignal = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    const config = (await this.rpc.call(
      'connectors.connection',
      {
        name: this.name,
      },
      { signal: requestSignal },
    )) as RemoteConnectorConnection & { kind: string };
    if (config.kind === 'microsoft365')
      return this.rpc.call(
        'connectors.graph',
        { name: this.name, method, params: params ?? {} },
        { signal: requestSignal },
      );
    this.client ??= connectRemoteConnector(
      (forceRefresh) =>
        this.rpc.call(
          'connectors.connection',
          {
            name: this.name,
            forceRefresh: forceRefresh ?? false,
          },
          { signal: this.lifetime.signal },
        ) as Promise<RemoteConnectorConnection>,
    ).catch((error) => {
      this.client = null;
      throw error;
    });
    const client = await this.client;
    return client.request({ method, params }, CONNECTOR_RESULTS[method], { signal: requestSignal });
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    const pending = this.client;
    this.client = null;
    if (pending) {
      // Failed connections already release their transport in connectRemoteConnector.
      const [connection] = await Promise.allSettled([pending]);
      if (connection.status === 'fulfilled') await connection.value.close();
    }
  }
}
export async function runConnectorForwarder(
  argv: readonly string[],
  rpc: OrchestratorToolsRpcClientLike = new OrchestratorToolsRpcClient(),
): Promise<void> {
  if (argv.length !== 1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(argv[0]))
    throw new Error('Usage: aio-mcp connector <name>');
  const relay = new ConnectorForwarder(argv[0], rpc);
  const server = new Server(
    { name: argv[0], version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  for (const schema of REQUESTS) {
    server.setRequestHandler(schema, async (request, extra) =>
      CONNECTOR_RESULTS[request.method].parse(
        await relay.dispatch(request.method, request.params, extra.signal),
      ),
    );
  }
  const transport = new StdioServerTransport();
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    rejectClosed = reject;
    transport.onclose = () => {
      void relay.close().then(resolve, reject);
    };
  });
  const shutdown = () => {
    void server.close().catch(rejectClosed);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
  try {
    await server.connect(transport);
    // The dispatcher exits when its runner resolves. Keep it alive for the
    // full stdio lifetime, including while the upstream connection is idle.
    await closed;
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    process.stdin.removeListener('end', shutdown);
    await relay.close();
    await server.close();
  }
}
