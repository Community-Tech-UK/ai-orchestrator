import { EventEmitter } from 'events';
import * as fs from 'fs';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import * as verbatimStore from '../persistence/rlm/rlm-verbatim';
import type {
  ConversationFormat,
  NormalizedMessage,
  MiningConfig,
  MiningResult,
  ConvoMemoryType,
} from '../../shared/types/conversation-mining.types';
import { DEFAULT_MINING_CONFIG } from '../../shared/types/conversation-mining.types';

const logger = getLogger('ConversationMiner');

interface ImportOptions {
  wing: string;
  sourceFile: string;
  format?: ConversationFormat;
  addedBy?: string;
}

interface TextChunk {
  content: string;
  chunkIndex: number;
}

export class ConversationMiner extends EventEmitter {
  private static instance: ConversationMiner | null = null;
  private config: MiningConfig;

  static getInstance(): ConversationMiner {
    if (!this.instance) {
      this.instance = new ConversationMiner();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  private constructor() {
    super();
    this.config = { ...DEFAULT_MINING_CONFIG };
    logger.info('ConversationMiner initialized');
  }

  configure(config: Partial<MiningConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private get db() {
    return getRLMDatabase().getRawDb();
  }

  // ============ Format Detection ============

  static detectFormat(content: string): ConversationFormat {
    const trimmed = content.trim();
    const markerCount = (trimmed.match(/^>/gm) || []).length;
    if (markerCount >= 3) return 'plain-text';

    const firstLine = trimmed.split('\n')[0]?.trim();
    if (firstLine?.startsWith('{')) {
      try {
        const parsed = JSON.parse(firstLine);
        if (parsed.type && parsed.message && typeof parsed.message === 'object') return 'claude-code-jsonl';
        if (parsed.type === 'session_meta' || parsed.type === 'event_msg') return 'codex-jsonl';
      } catch { /* not JSON line */ }
    }

    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const first = parsed[0];
          if (first.mapping || first.title) return 'chatgpt-json';
          if (first.chat_messages) return 'claude-ai-json';
          if (first.role) return 'claude-ai-json';
          if (first.type === 'message') return 'slack-json';
        }
      } catch { /* not JSON */ }
    }

    return 'plain-text';
  }

  // ============ Normalization ============

  static normalizeToMessages(content: string, format: ConversationFormat): NormalizedMessage[] {
    switch (format) {
      case 'plain-text': return normalizePlainText(content);
      case 'claude-code-jsonl': return normalizeClaudeCodeJsonl(content);
      case 'codex-jsonl': return normalizeCodexJsonl(content);
      case 'claude-ai-json': return normalizeClaudeAiJson(content);
      case 'chatgpt-json': return normalizeChatGptJson(content);
      case 'slack-json': return normalizeSlackJson(content);
      default: return normalizePlainText(content);
    }
  }

  // ============ Chunking ============

  static chunkExchanges(transcript: string, config?: Partial<MiningConfig>): TextChunk[] {
    const minSize = config?.minChunkSize ?? DEFAULT_MINING_CONFIG.minChunkSize;
    const markerCount = (transcript.match(/^>/gm) || []).length;
    if (markerCount >= 3) return chunkByExchange(transcript, minSize);
    return chunkByParagraph(transcript, config?.chunkSize ?? DEFAULT_MINING_CONFIG.chunkSize, minSize);
  }

  // ============ Room Detection ============

  static detectRoom(text: string, customKeywords?: Record<string, string[]>): ConvoMemoryType {
    const keywords = customKeywords ?? DEFAULT_MINING_CONFIG.topicKeywords;
    const lower = text.slice(0, 3000).toLowerCase();
    let bestRoom: ConvoMemoryType = 'general';
    let bestScore = 0;
    for (const [room, kws] of Object.entries(keywords)) {
      let score = 0;
      for (const kw of kws) {
        const regex = new RegExp(kw, 'gi');
        const matches = lower.match(regex);
        if (matches) score += matches.length;
      }
      if (score > bestScore) {
        bestScore = score;
        bestRoom = room as ConvoMemoryType;
      }
    }
    return bestRoom;
  }

  // ============ Import Pipeline ============

  importFromString(content: string, options: ImportOptions): MiningResult {
    const startTime = Date.now();
    const errors: string[] = [];
    const format = options.format ?? ConversationMiner.detectFormat(content);
    const messages = ConversationMiner.normalizeToMessages(content, format);
    if (messages.length < 2) {
      return { segmentsCreated: 0, filesProcessed: 1, formatDetected: format, errors: ['Too few messages (< 2)'], duration: Date.now() - startTime };
    }
    const transcript = messagesToTranscript(messages);
    const chunks = ConversationMiner.chunkExchanges(transcript, this.config);

    let importId: string | undefined;
    try {
      importId = verbatimStore.recordImport(this.db, {
        filePath: options.sourceFile,
        format,
        wing: options.wing,
        messageCount: messages.length,
      });
    } catch {
      errors.push(`File already imported: ${options.sourceFile}`);
      return { segmentsCreated: 0, filesProcessed: 1, formatDetected: format, errors, duration: Date.now() - startTime };
    }

    let segmentsCreated = 0;
    for (const chunk of chunks) {
      try {
        const room = ConversationMiner.detectRoom(chunk.content);
        verbatimStore.addSegment(this.db, {
          content: chunk.content,
          sourceFile: options.sourceFile,
          chunkIndex: chunk.chunkIndex,
          wing: options.wing,
          room,
          addedBy: options.addedBy ?? 'conversation-miner',
        });
        segmentsCreated++;
      } catch (err) {
        errors.push(`Chunk ${chunk.chunkIndex}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (importId) {
      verbatimStore.updateImportStatus(this.db, importId, errors.length === 0 ? 'imported' : 'failed', segmentsCreated, errors.length > 0 ? errors.join('; ') : undefined);
    }

    this.emit('miner:import-complete', { sourceFile: options.sourceFile, segmentsCreated, format });
    logger.info('Import complete', { sourceFile: options.sourceFile, segmentsCreated, format });
    return { segmentsCreated, filesProcessed: 1, formatDetected: format, errors, duration: Date.now() - startTime };
  }

  importFile(filePath: string, wing: string): MiningResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    return this.importFromString(content, { wing, sourceFile: filePath });
  }
}

export function getConversationMiner(): ConversationMiner {
  return ConversationMiner.getInstance();
}

// ============ Normalization Helpers ============

function normalizePlainText(content: string): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('>')) {
      messages.push({ role: 'user', content: line.slice(1).trim() });
      i++;
      const responseLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('>')) {
        const responseLine = lines[i].trim();
        if (responseLine) responseLines.push(responseLine);
        i++;
      }
      if (responseLines.length > 0) {
        messages.push({ role: 'assistant', content: responseLines.join('\n') });
      }
    } else {
      i++;
    }
  }
  return messages;
}

function normalizeClaudeCodeJsonl(content: string): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const type = entry.type;
      const text = entry.message?.content;
      if (!type || !text) continue;
      const role = (type === 'human' || type === 'user') ? 'user' : 'assistant';
      messages.push({ role, content: typeof text === 'string' ? text : JSON.stringify(text) });
    } catch { /* skip */ }
  }
  return messages;
}

function normalizeCodexJsonl(content: string): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'event_msg') continue;
      const payload = entry.payload;
      if (!payload?.type || !payload?.message) continue;
      if (typeof payload.message !== 'string') continue;
      const role = payload.type === 'user_message' ? 'user' : 'assistant';
      messages.push({ role, content: payload.message.trim() });
    } catch { /* skip */ }
  }
  return messages;
}

function normalizeClaudeAiJson(content: string): NormalizedMessage[] {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    if (parsed[0]?.chat_messages) {
      const messages: NormalizedMessage[] = [];
      for (const convo of parsed) {
        for (const msg of convo.chat_messages || []) {
          const role = (msg.sender === 'human' || msg.role === 'user' || msg.role === 'human') ? 'user' : 'assistant';
          const text = extractContent(msg.content ?? msg.text);
          if (text) messages.push({ role, content: text });
        }
      }
      return messages;
    }
    return parsed
      .filter((msg: Record<string, unknown>) => msg['role'] && (msg['content'] || msg['text']))
      .map((msg: Record<string, unknown>) => ({
        role: (msg['role'] === 'user' || msg['role'] === 'human') ? 'user' as const : 'assistant' as const,
        content: extractContent(msg['content'] ?? msg['text']),
      }));
  } catch { return []; }
}

function normalizeChatGptJson(content: string): NormalizedMessage[] {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    const messages: NormalizedMessage[] = [];
    for (const convo of parsed) {
      const mapping = convo.mapping;
      if (!mapping) continue;
      let rootId: string | undefined;
      for (const [id, node] of Object.entries(mapping) as [string, { parent: string | null; message: unknown; children: string[] }][]) {
        if (node.parent === null) { rootId = id; break; }
      }
      if (!rootId) continue;
      type ChatGPTNode = { message?: { author?: { role: string }; content?: { parts: string[] } }; children?: string[] };
      const typedMapping = mapping as Record<string, ChatGPTNode>;
      const visited = new Set<string>();
      let currentId: string | undefined = rootId;
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const chatNode: ChatGPTNode = typedMapping[currentId];
        if (chatNode?.message?.author?.role && chatNode.message.content?.parts) {
          const role = chatNode.message.author.role;
          if (role === 'user' || role === 'assistant') {
            const text = chatNode.message.content.parts.filter((p: unknown) => typeof p === 'string').join(' ');
            if (text.trim()) messages.push({ role: role as 'user' | 'assistant', content: text.trim() });
          }
        }
        currentId = chatNode?.children?.[0];
      }
    }
    return messages;
  } catch { return []; }
}

function normalizeSlackJson(content: string): NormalizedMessage[] {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    const messages: NormalizedMessage[] = [];
    const seenUsers = new Map<string, 'user' | 'assistant'>();
    for (const msg of parsed) {
      if (msg.type !== 'message' || !msg.text) continue;
      const userId = msg.user || msg.username;
      if (!userId) continue;
      if (!seenUsers.has(userId)) seenUsers.set(userId, seenUsers.size === 0 ? 'user' : 'assistant');
      messages.push({ role: seenUsers.get(userId)!, content: msg.text });
    }
    return messages;
  } catch { return []; }
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((item: unknown) => typeof item === 'string' || (typeof item === 'object' && item !== null && (item as Record<string, unknown>)['type'] === 'text'))
      .map((item: unknown) => typeof item === 'string' ? item : ((item as Record<string, string>)['text'] ?? ''))
      .join(' ');
  }
  if (typeof content === 'object' && content !== null) return ((content as Record<string, string>)['text'] ?? '');
  return '';
}

function messagesToTranscript(messages: NormalizedMessage[]): string {
  return messages.map(m => m.role === 'user' ? `> ${m.content}` : m.content).join('\n\n');
}

// ============ Chunking Helpers ============

function chunkByExchange(transcript: string, minSize: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  const lines = transcript.split('\n');
  let chunkIndex = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('>')) {
      const userTurn = lines[i];
      i++;
      const responseLines: string[] = [];
      let responseCount = 0;
      while (i < lines.length && !lines[i].startsWith('>') && responseCount < 8) {
        if (lines[i].trim()) { responseLines.push(lines[i]); responseCount++; }
        i++;
      }
      while (i < lines.length && !lines[i].startsWith('>') && !lines[i].trim().startsWith('---')) { i++; }
      const chunkContent = `${userTurn}\n${responseLines.join('\n')}`.trim();
      if (chunkContent.length >= minSize) { chunks.push({ content: chunkContent, chunkIndex }); chunkIndex++; }
    } else {
      i++;
    }
  }
  return chunks;
}

function chunkByParagraph(text: string, chunkSize: number, minSize: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  const stripped = text.trim();
  if (!stripped) return [];
  let start = 0;
  let chunkIndex = 0;
  while (start < stripped.length) {
    let end = Math.min(start + chunkSize, stripped.length);
    if (end < stripped.length) {
      const paraBreak = stripped.lastIndexOf('\n\n', end);
      if (paraBreak > start + chunkSize / 2) { end = paraBreak; }
      else {
        const lineBreak = stripped.lastIndexOf('\n', end);
        if (lineBreak > start + chunkSize / 2) { end = lineBreak; }
      }
    }
    const chunk = stripped.slice(start, end).trim();
    if (chunk.length >= minSize) { chunks.push({ content: chunk, chunkIndex }); chunkIndex++; }
    start = end < stripped.length ? end - DEFAULT_MINING_CONFIG.chunkOverlap : end;
    if (start <= 0 || start >= stripped.length) break;
    if (end === start) break;
  }
  return chunks;
}
