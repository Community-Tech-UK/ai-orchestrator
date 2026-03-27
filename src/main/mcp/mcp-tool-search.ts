/**
 * MCP Tool Search Service
 *
 * Dynamic tool discovery and search for Model Context Protocol:
 * - Indexes all available MCP tools from connected servers
 * - Provides semantic search across tool descriptions
 * - Dynamically loads tools based on task requirements
 * - Caches tool metadata for fast access
 * - Suggests relevant tools based on context
 */

import { EventEmitter } from 'events';

/**
 * MCP Tool definition
 */
export interface MCPTool {
  id: string;
  name: string;
  description: string;
  serverId: string;
  serverName: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  category?: string;
  tags: string[];
  examples?: ToolExample[];
  metadata: {
    version?: string;
    author?: string;
    deprecated?: boolean;
    experimental?: boolean;
    requiresAuth?: boolean;
  };
}

/**
 * Tool usage example
 */
export interface ToolExample {
  description: string;
  input: Record<string, unknown>;
  expectedOutput?: string;
}

/**
 * MCP Server definition
 */
export interface MCPServer {
  id: string;
  name: string;
  description?: string;
  uri: string;
  status: 'connected' | 'disconnected' | 'error';
  tools: string[]; // Tool IDs
  resources: string[];
  lastSeen: number;
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
    sampling: boolean;
  };
}

/**
 * Search result with relevance scoring
 */
export interface ToolSearchResult {
  tool: MCPTool;
  score: number;
  matchedFields: string[];
  highlights: Record<string, string>;
}

/**
 * Tool recommendation based on context
 */
export interface ToolRecommendation {
  tool: MCPTool;
  reason: string;
  confidence: number;
  contextMatch: string[];
}

/**
 * Search options
 */
export interface ToolSearchOptions {
  query?: string;
  category?: string;
  tags?: string[];
  serverId?: string;
  includeDeprecated?: boolean;
  includeExperimental?: boolean;
  maxResults?: number;
  minScore?: number;
}

/**
 * Tool index for fast search
 */
interface ToolIndex {
  tools: Map<string, MCPTool>;
  byName: Map<string, string[]>;
  byCategory: Map<string, string[]>;
  byTag: Map<string, string[]>;
  byServer: Map<string, string[]>;
  termIndex: Map<string, Set<string>>;
  lastUpdated: number;
}

/**
 * MCP Tool Search Service
 */
/**
 * Maximum length for MCP tool descriptions (in characters).
 * Prevents context window bloat when many MCP servers are connected.
 * Inspired by Claude Code 2.1.84 which caps descriptions at 2KB.
 */
const MAX_TOOL_DESCRIPTION_LENGTH = 2048;

/**
 * Truncate a tool description to the maximum allowed length.
 * Appends an ellipsis indicator if truncation occurs.
 */
function truncateDescription(description: string): string {
  if (description.length <= MAX_TOOL_DESCRIPTION_LENGTH) {
    return description;
  }
  return description.slice(0, MAX_TOOL_DESCRIPTION_LENGTH - 3) + '...';
}

/**
 * MCP Tool Search Service
 */
export class MCPToolSearchService extends EventEmitter {
  private servers: Map<string, MCPServer> = new Map();
  private index: ToolIndex;
  private loadedTools: Set<string> = new Set();
  private toolUsageStats: Map<string, { count: number; lastUsed: number; avgDuration: number }> = new Map();

  constructor() {
    super();
    this.index = this.createEmptyIndex();
  }

  /**
   * Create empty index
   */
  private createEmptyIndex(): ToolIndex {
    return {
      tools: new Map(),
      byName: new Map(),
      byCategory: new Map(),
      byTag: new Map(),
      byServer: new Map(),
      termIndex: new Map(),
      lastUpdated: Date.now(),
    };
  }

  /**
   * Register an MCP server
   */
  registerServer(server: MCPServer): void {
    this.servers.set(server.id, server);
    this.emit('server:registered', server);
  }

  /**
   * Unregister an MCP server
   */
  unregisterServer(serverId: string): void {
    const server = this.servers.get(serverId);
    if (!server) return;

    // Remove all tools from this server
    for (const toolId of server.tools) {
      this.removeTool(toolId);
    }

    this.servers.delete(serverId);
    this.emit('server:unregistered', { serverId });
  }

  /**
   * Index a tool for searching
   */
  indexTool(tool: MCPTool): void {
    // Truncate description to prevent context window bloat
    if (tool.description && tool.description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
      tool = { ...tool, description: truncateDescription(tool.description) };
    }

    // Store tool
    this.index.tools.set(tool.id, tool);

    // Index by name
    const nameKey = tool.name.toLowerCase();
    const nameList = this.index.byName.get(nameKey) || [];
    if (!nameList.includes(tool.id)) {
      nameList.push(tool.id);
      this.index.byName.set(nameKey, nameList);
    }

    // Index by category
    if (tool.category) {
      const categoryKey = tool.category.toLowerCase();
      const categoryList = this.index.byCategory.get(categoryKey) || [];
      if (!categoryList.includes(tool.id)) {
        categoryList.push(tool.id);
        this.index.byCategory.set(categoryKey, categoryList);
      }
    }

    // Index by tags
    for (const tag of tool.tags) {
      const tagKey = tag.toLowerCase();
      const tagList = this.index.byTag.get(tagKey) || [];
      if (!tagList.includes(tool.id)) {
        tagList.push(tool.id);
        this.index.byTag.set(tagKey, tagList);
      }
    }

    // Index by server
    const serverList = this.index.byServer.get(tool.serverId) || [];
    if (!serverList.includes(tool.id)) {
      serverList.push(tool.id);
      this.index.byServer.set(tool.serverId, serverList);
    }

    // Build term index for full-text search
    this.indexTerms(tool);

    this.index.lastUpdated = Date.now();
    this.emit('tool:indexed', tool);
  }

  /**
   * Index terms from tool for full-text search
   */
  private indexTerms(tool: MCPTool): void {
    const textToIndex = [
      tool.name,
      tool.description,
      tool.category || '',
      ...tool.tags,
      ...(tool.examples?.map(e => e.description) || []),
    ].join(' ');

    // Extract and normalize terms
    const terms = textToIndex
      .toLowerCase()
      .split(/\W+/)
      .filter(term => term.length > 2);

    for (const term of terms) {
      const termSet = this.index.termIndex.get(term) || new Set();
      termSet.add(tool.id);
      this.index.termIndex.set(term, termSet);
    }
  }

  /**
   * Remove a tool from the index
   */
  removeTool(toolId: string): void {
    const tool = this.index.tools.get(toolId);
    if (!tool) return;

    this.index.tools.delete(toolId);

    // Remove from all indices
    const nameKey = tool.name.toLowerCase();
    const nameList = this.index.byName.get(nameKey);
    if (nameList) {
      const idx = nameList.indexOf(toolId);
      if (idx !== -1) nameList.splice(idx, 1);
    }

    if (tool.category) {
      const categoryList = this.index.byCategory.get(tool.category.toLowerCase());
      if (categoryList) {
        const idx = categoryList.indexOf(toolId);
        if (idx !== -1) categoryList.splice(idx, 1);
      }
    }

    for (const tag of tool.tags) {
      const tagList = this.index.byTag.get(tag.toLowerCase());
      if (tagList) {
        const idx = tagList.indexOf(toolId);
        if (idx !== -1) tagList.splice(idx, 1);
      }
    }

    const serverList = this.index.byServer.get(tool.serverId);
    if (serverList) {
      const idx = serverList.indexOf(toolId);
      if (idx !== -1) serverList.splice(idx, 1);
    }

    // Remove from term index
    for (const [, termSet] of this.index.termIndex) {
      termSet.delete(toolId);
    }

    this.loadedTools.delete(toolId);
    this.emit('tool:removed', { toolId });
  }

  /**
   * Search for tools
   */
  search(options: ToolSearchOptions): ToolSearchResult[] {
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

    let candidateIds: Set<string>;

    // Start with all tools or filter by constraints
    if (serverId) {
      candidateIds = new Set(this.index.byServer.get(serverId) || []);
    } else if (category) {
      candidateIds = new Set(this.index.byCategory.get(category.toLowerCase()) || []);
    } else if (tags && tags.length > 0) {
      candidateIds = new Set();
      for (const tag of tags) {
        const tagTools = this.index.byTag.get(tag.toLowerCase()) || [];
        for (const toolId of tagTools) {
          candidateIds.add(toolId);
        }
      }
    } else {
      candidateIds = new Set(this.index.tools.keys());
    }

    // Score candidates
    const results: ToolSearchResult[] = [];

    for (const toolId of candidateIds) {
      const tool = this.index.tools.get(toolId);
      if (!tool) continue;

      // Filter out deprecated/experimental if needed
      if (!includeDeprecated && tool.metadata.deprecated) continue;
      if (!includeExperimental && tool.metadata.experimental) continue;

      // Calculate relevance score
      const scoreResult = this.scoreTool(tool, query, tags);

      if (scoreResult.score >= minScore) {
        results.push({
          tool,
          score: scoreResult.score,
          matchedFields: scoreResult.matchedFields,
          highlights: scoreResult.highlights,
        });
      }
    }

    // Sort by score and limit results
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /**
   * Score a tool against search criteria
   */
  private scoreTool(
    tool: MCPTool,
    query?: string,
    tags?: string[]
  ): { score: number; matchedFields: string[]; highlights: Record<string, string> } {
    let score = 0;
    const matchedFields: string[] = [];
    const highlights: Record<string, string> = {};

    if (!query && (!tags || tags.length === 0)) {
      // No search criteria - return base score
      return { score: 0.5, matchedFields: [], highlights: {} };
    }

    if (query) {
      const queryLower = query.toLowerCase();
      const queryTerms = queryLower.split(/\W+/).filter(t => t.length > 2);

      // Exact name match
      if (tool.name.toLowerCase() === queryLower) {
        score += 1.0;
        matchedFields.push('name');
        highlights['name'] = tool.name;
      } else if (tool.name.toLowerCase().includes(queryLower)) {
        score += 0.7;
        matchedFields.push('name');
        highlights['name'] = this.highlight(tool.name, queryLower);
      }

      // Description match
      if (tool.description.toLowerCase().includes(queryLower)) {
        score += 0.5;
        matchedFields.push('description');
        highlights['description'] = this.highlight(tool.description, queryLower);
      }

      // Term-based scoring
      let termMatches = 0;
      for (const term of queryTerms) {
        const termSet = this.index.termIndex.get(term);
        if (termSet?.has(tool.id)) {
          termMatches++;
        }
      }
      if (termMatches > 0) {
        score += 0.3 * (termMatches / queryTerms.length);
      }

      // Category match
      if (tool.category?.toLowerCase().includes(queryLower)) {
        score += 0.3;
        matchedFields.push('category');
      }
    }

    // Tag matching
    if (tags && tags.length > 0) {
      const toolTagsLower = tool.tags.map(t => t.toLowerCase());
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

    // Boost for popular tools
    const stats = this.toolUsageStats.get(tool.id);
    if (stats) {
      score += Math.min(0.2, stats.count * 0.01);
    }

    // Normalize score to 0-1 range
    score = Math.min(1, score);

    return { score, matchedFields, highlights };
  }

  /**
   * Highlight matching text
   */
  private highlight(text: string, query: string): string {
    const regex = new RegExp(`(${query})`, 'gi');
    return text.replace(regex, '**$1**');
  }

  /**
   * Get tool recommendations based on context
   */
  recommendTools(context: {
    currentTask?: string;
    recentTools?: string[];
    fileTypes?: string[];
    keywords?: string[];
  }): ToolRecommendation[] {
    const recommendations: ToolRecommendation[] = [];

    // Search based on current task
    if (context.currentTask) {
      const taskResults = this.search({
        query: context.currentTask,
        maxResults: 5,
        minScore: 0.3,
      });

      for (const result of taskResults) {
        recommendations.push({
          tool: result.tool,
          reason: `Relevant to current task: "${context.currentTask}"`,
          confidence: result.score,
          contextMatch: result.matchedFields,
        });
      }
    }

    // Suggest based on file types
    if (context.fileTypes && context.fileTypes.length > 0) {
      const fileTypeTools = this.getToolsForFileTypes(context.fileTypes);
      for (const tool of fileTypeTools) {
        if (!recommendations.find(r => r.tool.id === tool.id)) {
          recommendations.push({
            tool,
            reason: `Works with file types: ${context.fileTypes.join(', ')}`,
            confidence: 0.6,
            contextMatch: ['fileType'],
          });
        }
      }
    }

    // Suggest complementary tools based on recent usage
    if (context.recentTools && context.recentTools.length > 0) {
      const complementary = this.getComplementaryTools(context.recentTools);
      for (const tool of complementary) {
        if (!recommendations.find(r => r.tool.id === tool.id)) {
          recommendations.push({
            tool,
            reason: 'Often used with your recent tools',
            confidence: 0.5,
            contextMatch: ['usage-pattern'],
          });
        }
      }
    }

    // Keyword-based suggestions
    if (context.keywords && context.keywords.length > 0) {
      const keywordResults = this.search({
        tags: context.keywords,
        maxResults: 5,
        minScore: 0.2,
      });

      for (const result of keywordResults) {
        if (!recommendations.find(r => r.tool.id === result.tool.id)) {
          recommendations.push({
            tool: result.tool,
            reason: `Matches keywords: ${context.keywords.join(', ')}`,
            confidence: result.score * 0.8,
            contextMatch: result.matchedFields,
          });
        }
      }
    }

    // Sort by confidence and limit
    recommendations.sort((a, b) => b.confidence - a.confidence);
    return recommendations.slice(0, 10);
  }

  /**
   * Get tools for specific file types
   */
  private getToolsForFileTypes(fileTypes: string[]): MCPTool[] {
    const tools: MCPTool[] = [];
    const fileTypePatterns: Record<string, string[]> = {
      '.ts': ['typescript', 'javascript', 'code', 'lint'],
      '.js': ['javascript', 'code', 'lint'],
      '.py': ['python', 'code', 'lint'],
      '.md': ['markdown', 'documentation'],
      '.json': ['json', 'config'],
      '.yaml': ['yaml', 'config'],
      '.sql': ['sql', 'database'],
      '.html': ['html', 'web'],
      '.css': ['css', 'style', 'web'],
    };

    const relevantTags: Set<string> = new Set();
    for (const fileType of fileTypes) {
      const patterns = fileTypePatterns[fileType] || [];
      for (const pattern of patterns) {
        relevantTags.add(pattern);
      }
    }

    for (const tool of this.index.tools.values()) {
      const toolTagsLower = tool.tags.map(t => t.toLowerCase());
      if (toolTagsLower.some(t => relevantTags.has(t))) {
        tools.push(tool);
      }
    }

    return tools;
  }

  /**
   * Get complementary tools based on usage patterns
   */
  private getComplementaryTools(recentToolIds: string[]): MCPTool[] {
    // Simple heuristic: tools from same server or same category
    const tools: MCPTool[] = [];
    const seenServers: Set<string> = new Set();
    const seenCategories: Set<string> = new Set();

    for (const toolId of recentToolIds) {
      const tool = this.index.tools.get(toolId);
      if (tool) {
        seenServers.add(tool.serverId);
        if (tool.category) seenCategories.add(tool.category);
      }
    }

    for (const tool of this.index.tools.values()) {
      if (recentToolIds.includes(tool.id)) continue;

      if (seenServers.has(tool.serverId) || (tool.category && seenCategories.has(tool.category))) {
        tools.push(tool);
      }
    }

    return tools.slice(0, 5);
  }

  /**
   * Dynamically load a tool (mark as ready for use)
   */
  async loadTool(toolId: string): Promise<boolean> {
    const tool = this.index.tools.get(toolId);
    if (!tool) return false;

    const server = this.servers.get(tool.serverId);
    if (!server || server.status !== 'connected') {
      this.emit('tool:load-failed', { toolId, reason: 'Server not connected' });
      return false;
    }

    this.loadedTools.add(toolId);
    this.emit('tool:loaded', tool);
    return true;
  }

  /**
   * Unload a tool
   */
  unloadTool(toolId: string): void {
    this.loadedTools.delete(toolId);
    this.emit('tool:unloaded', { toolId });
  }

  /**
   * Check if a tool is loaded
   */
  isToolLoaded(toolId: string): boolean {
    return this.loadedTools.has(toolId);
  }

  /**
   * Get loaded tools
   */
  getLoadedTools(): MCPTool[] {
    return Array.from(this.loadedTools)
      .map(id => this.index.tools.get(id))
      .filter((t): t is MCPTool => t !== undefined);
  }

  /**
   * Record tool usage for analytics
   */
  recordToolUsage(toolId: string, duration: number): void {
    const stats = this.toolUsageStats.get(toolId) || {
      count: 0,
      lastUsed: 0,
      avgDuration: 0,
    };

    stats.avgDuration = (stats.avgDuration * stats.count + duration) / (stats.count + 1);
    stats.count++;
    stats.lastUsed = Date.now();

    this.toolUsageStats.set(toolId, stats);
    this.emit('tool:usage-recorded', { toolId, stats });
  }

  /**
   * Get tool by ID
   */
  getTool(toolId: string): MCPTool | undefined {
    return this.index.tools.get(toolId);
  }

  /**
   * Get all tools
   */
  getAllTools(): MCPTool[] {
    return Array.from(this.index.tools.values());
  }

  /**
   * Get tools by server
   */
  getToolsByServer(serverId: string): MCPTool[] {
    const toolIds = this.index.byServer.get(serverId) || [];
    return toolIds
      .map(id => this.index.tools.get(id))
      .filter((t): t is MCPTool => t !== undefined);
  }

  /**
   * Get tools by category
   */
  getToolsByCategory(category: string): MCPTool[] {
    const toolIds = this.index.byCategory.get(category.toLowerCase()) || [];
    return toolIds
      .map(id => this.index.tools.get(id))
      .filter((t): t is MCPTool => t !== undefined);
  }

  /**
   * Get all categories
   */
  getCategories(): string[] {
    return Array.from(this.index.byCategory.keys());
  }

  /**
   * Get all tags
   */
  getAllTags(): string[] {
    return Array.from(this.index.byTag.keys());
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalTools: number;
    totalServers: number;
    loadedTools: number;
    categories: number;
    tags: number;
    indexedTerms: number;
    lastUpdated: number;
    topUsedTools: { toolId: string; count: number }[];
  } {
    const topUsed = Array.from(this.toolUsageStats.entries())
      .map(([toolId, stats]) => ({ toolId, count: stats.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalTools: this.index.tools.size,
      totalServers: this.servers.size,
      loadedTools: this.loadedTools.size,
      categories: this.index.byCategory.size,
      tags: this.index.byTag.size,
      indexedTerms: this.index.termIndex.size,
      lastUpdated: this.index.lastUpdated,
      topUsedTools: topUsed,
    };
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.servers.clear();
    this.index = this.createEmptyIndex();
    this.loadedTools.clear();
    this.toolUsageStats.clear();
    this.emit('index:cleared');
  }

  /**
   * Export index for backup
   */
  exportIndex(): {
    tools: MCPTool[];
    servers: MCPServer[];
    usageStats: Record<string, { count: number; lastUsed: number; avgDuration: number }>;
  } {
    return {
      tools: Array.from(this.index.tools.values()),
      servers: Array.from(this.servers.values()),
      usageStats: Object.fromEntries(this.toolUsageStats),
    };
  }

  /**
   * Import index from backup
   */
  importIndex(data: {
    tools: MCPTool[];
    servers: MCPServer[];
    usageStats?: Record<string, { count: number; lastUsed: number; avgDuration: number }>;
  }): void {
    this.clear();

    for (const server of data.servers) {
      this.servers.set(server.id, server);
    }

    for (const tool of data.tools) {
      this.indexTool(tool);
    }

    if (data.usageStats) {
      this.toolUsageStats = new Map(Object.entries(data.usageStats));
    }

    this.emit('index:imported');
  }
}

// Singleton instance
let mcpToolSearchInstance: MCPToolSearchService | null = null;

export function getMCPToolSearchService(): MCPToolSearchService {
  if (!mcpToolSearchInstance) {
    mcpToolSearchInstance = new MCPToolSearchService();
  }
  return mcpToolSearchInstance;
}
