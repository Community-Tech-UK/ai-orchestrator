import type {
  MCPServerSummary,
  MCPTool,
  ToolSearchOptions,
  ToolSearchResult,
} from './mcp-tool-search';

export interface MCPToolUsageStats {
  count: number;
  lastUsed: number;
  avgDuration: number;
}

export interface MCPToolSearchSnapshot {
  tools: MCPTool[];
  serverSummaries: MCPServerSummary[];
  loadedToolIds: string[];
  usageStats: Record<string, MCPToolUsageStats>;
  indices: {
    byCategory: Record<string, string[]>;
    byServer: Record<string, string[]>;
    byTag: Record<string, string[]>;
    termIndex: Record<string, string[]>;
  };
}

export interface McpRuntimeToolContextSelection {
  serverSummaries: MCPServerSummary[];
  selectedToolIds: string[];
  deferredToolCount: number;
  query: string | null;
}

const BROWSER_GATEWAY_SERVER_ID = 'browser-gateway';
const BROWSER_GATEWAY_FRONT_DOOR_TOOL_NAMES = [
  'browser.list_targets',
  'browser.find_or_open',
  'browser.health',
] as const;

function highlight(text: string, query: string): string {
  const regex = new RegExp(`(${query})`, 'gi');
  return text.replace(regex, '**$1**');
}

function scoreTool(
  tool: MCPTool,
  query: string | undefined,
  tags: string[] | undefined,
  usageStats: Record<string, MCPToolUsageStats>,
  termIndex: Record<string, string[]>,
): { score: number; matchedFields: string[]; highlights: Record<string, string> } {
  let score = 0;
  const matchedFields: string[] = [];
  const highlights: Record<string, string> = {};

  if (!query && (!tags || tags.length === 0)) {
    return { score: 0.5, matchedFields: [], highlights: {} };
  }

  if (query) {
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\W+/).filter((term) => term.length > 2);

    if (tool.name.toLowerCase() === queryLower) {
      score += 1.0;
      matchedFields.push('name');
      highlights['name'] = tool.name;
    } else if (tool.name.toLowerCase().includes(queryLower)) {
      score += 0.7;
      matchedFields.push('name');
      highlights['name'] = highlight(tool.name, queryLower);
    }

    if (tool.description.toLowerCase().includes(queryLower)) {
      score += 0.5;
      matchedFields.push('description');
      highlights['description'] = highlight(tool.description, queryLower);
    }

    let termMatches = 0;
    for (const term of queryTerms) {
      if (termIndex[term]?.includes(tool.id)) {
        termMatches++;
      }
    }
    if (termMatches > 0 && queryTerms.length > 0) {
      score += 0.3 * (termMatches / queryTerms.length);
    }

    if (tool.category?.toLowerCase().includes(queryLower)) {
      score += 0.3;
      matchedFields.push('category');
    }
  }

  if (tags && tags.length > 0) {
    const toolTagsLower = tool.tags.map((tag) => tag.toLowerCase());
    let tagMatches = 0;

    for (const tag of tags) {
      if (toolTagsLower.includes(tag.toLowerCase())) {
        tagMatches++;
      }
    }

    if (tagMatches > 0) {
      score += 0.4 * (tagMatches / tags.length);
      matchedFields.push('tags');
    }
  }

  const stats = usageStats[tool.id];
  if (stats) {
    score += Math.min(0.2, stats.count * 0.01);
  }

  return {
    score: Math.min(1, score),
    matchedFields,
    highlights,
  };
}

export function searchMcpToolsSnapshot(
  snapshot: MCPToolSearchSnapshot,
  options: ToolSearchOptions,
): ToolSearchResult[] {
  const {
    query,
    category,
    tags,
    serverId,
    includeDeprecated = false,
    includeExperimental = true,
    maxResults = 20,
    minScore = 0.1,
  } = options;

  const toolsById = new Map(snapshot.tools.map((tool) => [tool.id, tool]));

  let candidateIds: Set<string>;
  if (serverId) {
    candidateIds = new Set(snapshot.indices.byServer[serverId] ?? []);
  } else if (category) {
    candidateIds = new Set(snapshot.indices.byCategory[category.toLowerCase()] ?? []);
  } else if (tags && tags.length > 0) {
    candidateIds = new Set<string>();
    for (const tag of tags) {
      for (const toolId of snapshot.indices.byTag[tag.toLowerCase()] ?? []) {
        candidateIds.add(toolId);
      }
    }
  } else {
    candidateIds = new Set(snapshot.tools.map((tool) => tool.id));
  }

  const results: ToolSearchResult[] = [];
  for (const toolId of candidateIds) {
    const tool = toolsById.get(toolId);
    if (!tool) continue;
    if (!includeDeprecated && tool.metadata.deprecated) continue;
    if (!includeExperimental && tool.metadata.experimental) continue;

    const scored = scoreTool(
      tool,
      query,
      tags,
      snapshot.usageStats,
      snapshot.indices.termIndex,
    );
    if (scored.score < minScore) continue;

    results.push({
      tool,
      score: scored.score,
      matchedFields: scored.matchedFields,
      highlights: scored.highlights,
    });
  }

  results.sort((left, right) => right.score - left.score);
  return results.slice(0, maxResults);
}

export function buildMcpRuntimeToolContextSelection(
  snapshot: MCPToolSearchSnapshot,
  options: Pick<ToolSearchOptions, 'query'> & { maxTools?: number } = {},
): McpRuntimeToolContextSelection {
  const maxTools = options.maxTools ?? 6;
  const query = options.query?.trim() ? options.query.trim() : undefined;

  const searchSelectedToolIds = query
    ? searchMcpToolsSnapshot(snapshot, {
        query,
        includeDeprecated: false,
        includeExperimental: true,
        maxResults: maxTools,
        minScore: 0.15,
      }).map((result) => result.tool.id)
    : snapshot.loadedToolIds.slice(0, maxTools);
  const selectedToolIds = mergePinnedToolIds(
    pinnedToolIdsForQuery(snapshot, query),
    searchSelectedToolIds,
    maxTools,
  );

  return {
    serverSummaries: snapshot.serverSummaries,
    selectedToolIds,
    deferredToolCount: Math.max(0, snapshot.tools.length - selectedToolIds.length),
    query: query ?? null,
  };
}

function pinnedToolIdsForQuery(
  snapshot: MCPToolSearchSnapshot,
  query: string | undefined,
): string[] {
  if (!query || !isBrowserGatewayFrontDoorQuery(query)) {
    return [];
  }

  const browserGatewayTools = new Map(
    snapshot.tools
      .filter((tool) => tool.serverId === BROWSER_GATEWAY_SERVER_ID)
      .map((tool) => [tool.name, tool.id]),
  );
  return BROWSER_GATEWAY_FRONT_DOOR_TOOL_NAMES
    .map((name) => browserGatewayTools.get(name))
    .filter((toolId): toolId is string => Boolean(toolId));
}

function isBrowserGatewayFrontDoorQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  if (/\bbrowser\s+gateway\b/.test(normalized)) {
    return true;
  }

  const mentionsBrowserSurface =
    /\b(browser|chrome|tab|url|web\s*page|website|login|logged[-\s]*in|form)\b/.test(normalized);
  const mentionsSharedOrComputer =
    /\b(shared|share|open|current|mac|local|windows[-\s]*pc|pc|computer)\b/.test(normalized);
  return mentionsBrowserSurface && mentionsSharedOrComputer;
}

function mergePinnedToolIds(
  pinnedToolIds: string[],
  selectedToolIds: string[],
  maxTools: number,
): string[] {
  const merged: string[] = [];
  for (const toolId of [...pinnedToolIds, ...selectedToolIds]) {
    if (merged.includes(toolId)) {
      continue;
    }
    merged.push(toolId);
    if (merged.length >= maxTools) {
      break;
    }
  }
  return merged;
}
