import { describe, expect, it } from 'vitest';
import {
  buildMcpRuntimeToolContextSelection,
  searchMcpToolsSnapshot,
  type MCPToolSearchSnapshot,
} from './mcp-runtime-tool-context';

function createSnapshot(): MCPToolSearchSnapshot {
  return {
    tools: [
      {
        id: 'db.query',
        name: 'query_database',
        description: 'Run SQL queries against the app database',
        serverId: 'db',
        serverName: 'Database',
        inputSchema: {},
        tags: ['sql', 'database'],
        metadata: {},
      },
      {
        id: 'fs.read',
        name: 'read_file',
        description: 'Read files from disk',
        serverId: 'fs',
        serverName: 'Filesystem',
        inputSchema: {},
        tags: ['file', 'filesystem'],
        metadata: {},
      },
    ],
    serverSummaries: [
      {
        serverId: 'db',
        serverName: 'Database',
        toolCount: 1,
        resourceCount: 0,
        promptCount: 0,
        searchHint: 'Search DB tools',
      },
      {
        serverId: 'fs',
        serverName: 'Filesystem',
        toolCount: 1,
        resourceCount: 0,
        promptCount: 0,
        searchHint: 'Search FS tools',
      },
    ],
    loadedToolIds: ['fs.read'],
    usageStats: {
      'db.query': { count: 8, lastUsed: Date.now(), avgDuration: 25 },
    },
    indices: {
      byCategory: {},
      byServer: { db: ['db.query'], fs: ['fs.read'] },
      byTag: { sql: ['db.query'], database: ['db.query'], file: ['fs.read'], filesystem: ['fs.read'] },
      termIndex: {
        run: ['db.query'],
        sql: ['db.query'],
        queries: ['db.query'],
        against: ['db.query'],
        app: ['db.query'],
        database: ['db.query'],
        read: ['fs.read'],
        files: ['fs.read'],
        from: ['fs.read'],
        disk: ['fs.read'],
      },
    },
  };
}

describe('mcp-runtime-tool-context', () => {
  it('searches snapshot data without a live service instance', () => {
    const results = searchMcpToolsSnapshot(createSnapshot(), {
      query: 'sql database',
      maxResults: 3,
      minScore: 0.1,
    });

    expect(results[0]?.tool.id).toBe('db.query');
  });

  it('prefers currently loaded tools when there is no search query', () => {
    const selection = buildMcpRuntimeToolContextSelection(createSnapshot(), { maxTools: 2 });

    expect(selection.selectedToolIds).toEqual(['fs.read']);
    expect(selection.deferredToolCount).toBe(1);
  });
});
