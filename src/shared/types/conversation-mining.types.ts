/**
 * Conversation Mining Types
 * Parse and index past AI conversations from multiple formats.
 * Inspired by mempalace's normalize.py + convo_miner.py
 *
 * Supported Formats:
 * - Claude Code JSONL (type: human/assistant, message.content)
 * - Codex CLI JSONL (type: event_msg, payload.type: user_message/agent_message)
 * - Claude.ai JSON (flat messages or privacy export with chat_messages)
 * - ChatGPT conversations.json (tree structure via mapping dict)
 * - Slack JSON (message array with user role alternation)
 * - Plain text (> marker format)
 */

export type ConversationFormat =
  | 'claude-code-jsonl'
  | 'codex-jsonl'
  | 'claude-ai-json'
  | 'chatgpt-json'
  | 'slack-json'
  | 'plain-text';

export type MessageRole = 'user' | 'assistant';

export interface NormalizedMessage {
  role: MessageRole;
  content: string;
  timestamp?: number;
}

export type ConvoMemoryType =
  | 'technical'
  | 'architecture'
  | 'planning'
  | 'decisions'
  | 'problems'
  | 'general';

export interface ConversationSegment {
  id: string;
  content: string;
  chunkIndex: number;
  memoryType: ConvoMemoryType;
  sourceFile: string;
  wing: string;
  room: string;
  importedAt: number;
}

export interface ImportSource {
  filePath: string;
  format: ConversationFormat;
  wing: string;
  detectedAt: number;
  messageCount: number;
  status: 'pending' | 'imported' | 'failed';
  error?: string;
}

export interface MiningConfig {
  chunkSize: number;
  chunkOverlap: number;
  minChunkSize: number;
  maxFileSize: number;
  topicKeywords: Record<string, string[]>;
}

export const DEFAULT_MINING_CONFIG: MiningConfig = {
  chunkSize: 800,
  chunkOverlap: 100,
  minChunkSize: 50,
  maxFileSize: 10 * 1024 * 1024,
  topicKeywords: {
    technical: ['code', 'python', 'function', 'bug', 'error', 'api', 'database', 'server', 'deploy', 'git', 'test', 'debug', 'refactor'],
    architecture: ['architecture', 'design', 'pattern', 'structure', 'schema', 'interface', 'module', 'component', 'service', 'layer'],
    planning: ['plan', 'roadmap', 'milestone', 'deadline', 'priority', 'sprint', 'backlog', 'scope', 'requirement', 'spec'],
    decisions: ['decided', 'chose', 'picked', 'switched', 'migrated', 'replaced', 'trade-off', 'alternative', 'option', 'approach'],
    problems: ['problem', 'issue', 'broken', 'failed', 'crash', 'stuck', 'workaround', 'fix', 'solved', 'resolved'],
  },
};

export interface MiningResult {
  segmentsCreated: number;
  filesProcessed: number;
  formatDetected: ConversationFormat;
  errors: string[];
  duration: number;
}

export interface VerbatimEntry {
  id: string;
  content: string;
  sourceFile: string;
  chunkIndex: number;
  wing: string;
  room: string;
  importance: number;
  addedBy: string;
  createdAt: number;
}
