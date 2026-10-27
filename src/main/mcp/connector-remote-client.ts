import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';

export interface RemoteConnectorConnection {
  url: string;
  headers?: Record<string, string>;
  transport?: string;
  accessToken?: string;
}
export const CONNECTOR_RESULTS = {
  'tools/list': ListToolsResultSchema,
  'tools/call': CallToolResultSchema,
  'resources/list': ListResourcesResultSchema,
  'resources/read': ReadResourceResultSchema,
  'prompts/list': ListPromptsResultSchema,
  'prompts/get': GetPromptResultSchema,
} as const;
export type ConnectorMethod = keyof typeof CONNECTOR_RESULTS;

export async function connectRemoteConnector(
  getConnection: (forceRefresh?: boolean) => Promise<RemoteConnectorConnection>,
): Promise<Client> {
  const connection = await getConnection();
  const endpoint = new URL(connection.url);
  const tokenFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== endpoint.origin)
      throw new Error('Connector attempted to send credentials to another service.');
    const execute = async (forceRefresh: boolean) => {
      const current = await getConnection(forceRefresh);
      if (current.url !== connection.url)
        throw new Error('Connector address changed. Start a new session.');
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(current.headers ?? {})) headers.set(key, value);
      if (current.accessToken) headers.set('Authorization', `Bearer ${current.accessToken}`);
      return fetch(input, { ...init, headers, redirect: 'manual' });
    };
    const response = await execute(false);
    if (response.status === 401) {
      await response.body?.cancel();
      return execute(true);
    }
    return response;
  };
  const client = new Client({ name: 'harness-connector', version: '1.0.0' });
  const transport =
    connection.transport === 'sse'
      ? new SSEClientTransport(endpoint, {
          fetch: tokenFetch,
          eventSourceInit: { fetch: tokenFetch },
        })
      : new StreamableHTTPClientTransport(endpoint, { fetch: tokenFetch });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
