import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type { OutputMessage, ThinkingContent } from '../../shared/types/instance.types';

export interface ImportedTranscript {
  sessionId: string;
  workingDirectory: string;
  createdAt: number;
  endedAt: number;
  messages: OutputMessage[];
  firstUserMessage: string;
  lastUserMessage: string;
}

export type ClaudeJsonlTranscriptSkipReason = 'empty' | 'non-main-entrypoint';

export interface ClaudeJsonlTranscriptParseResult {
  transcript: ImportedTranscript | null;
  sessionId: string;
  entrypoints: string[];
  skipReason?: ClaudeJsonlTranscriptSkipReason;
}

interface ClaudeJsonlContentBlock {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  thinking?: string;
  content?: unknown;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ClaudeJsonlLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  entrypoint?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: string | ClaudeJsonlContentBlock[];
  };
}

export interface ClaudeJsonlTranscriptParseOptions {
  /**
   * Claude labels orchestrated top-level sessions as `sdk-cli`, the same
   * entrypoint used by genuine child agents. Keep the default fail-closed;
   * callers may opt in only after independently proving the file belongs to an
   * existing top-level app session.
   */
  allowNonMainEntrypoint?: boolean;

  /** Preserve native tool-use/result roles and metadata instead of flattening them into text. */
  preserveToolMessages?: boolean;
}

/**
 * True when an archived display transcript is a strict tail of a longer native
 * Claude transcript. Tool results and app-generated system notices are omitted
 * because they are not consistently persisted by both sources.
 */
export function isNativeTranscriptTailExtension(
  nativeMessages: OutputMessage[],
  archivedMessages: OutputMessage[],
): boolean {
  const comparableTypes = new Set<OutputMessage['type']>(['user', 'assistant', 'tool_use']);
  const native = nativeMessages.filter(
    (message) => comparableTypes.has(message.type) && message.content.trim().length > 0,
  );
  const archived = archivedMessages.filter(
    (message) => comparableTypes.has(message.type) && message.content.trim().length > 0,
  );
  if (archived.length === 0 || native.length <= archived.length) {
    return false;
  }

  return archived.every((message, index) => {
    const nativeMessage = native[native.length - archived.length + index];
    return nativeMessage?.type === message.type && nativeMessage.content === message.content;
  });
}

export function getDefaultClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export async function findClaudeJsonlFiles(projectsDir: string): Promise<string[]> {
  if (!fs.existsSync(projectsDir)) {
    return [];
  }
  const out: string[] = [];
  const subdirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  for (const dirent of subdirs) {
    if (!dirent.isDirectory()) continue;
    const subPath = path.join(projectsDir, dirent.name);
    let files: string[];
    try {
      files = await fs.promises.readdir(subPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) {
        out.push(path.join(subPath, f));
      }
    }
  }
  return out;
}

function extractTextFromContentBlocks(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as ClaudeJsonlContentBlock;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      parts.push(b.thinking);
    } else if (b.type === 'tool_result') {
      if (typeof b.content === 'string') {
        parts.push(b.content);
      } else if (Array.isArray(b.content)) {
        for (const c of b.content) {
          if (c && typeof c === 'object') {
            const cc = c as ClaudeJsonlContentBlock;
            if (cc.type === 'text' && typeof cc.text === 'string') {
              parts.push(cc.text);
            }
          }
        }
      }
    }
  }
  return parts.join('\n').trim();
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const nested of content) {
    if (!nested || typeof nested !== 'object') continue;
    const block = nested as ClaudeJsonlContentBlock;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function createBlockMessageId(baseId: string, blockIndex: number): string {
  return `${baseId}:${blockIndex}`;
}

function extractStructuredMessages(
  parsed: ClaudeJsonlLine,
  lineType: 'user' | 'assistant',
  timestamp: number,
): OutputMessage[] {
  const content = parsed.message?.content;
  const baseId = parsed.uuid ?? globalThis.crypto.randomUUID();

  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed
      ? [{ id: baseId, timestamp, type: lineType, content: trimmed }]
      : [];
  }
  if (!Array.isArray(content)) return [];

  const messages: OutputMessage[] = [];
  let pendingThinking: ThinkingContent[] = [];

  for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
    const block = content[blockIndex];
    if (!block || typeof block !== 'object') continue;
    const messageId = createBlockMessageId(baseId, blockIndex);

    if (lineType === 'assistant') {
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        pendingThinking.push({
          id: `${messageId}:thinking`,
          content: block.thinking,
          format: 'structured',
          timestamp,
        });
        continue;
      }

      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        if (text || pendingThinking.length > 0) {
          messages.push({
            id: messageId,
            timestamp,
            type: 'assistant',
            content: text,
            thinking: pendingThinking.length > 0 ? pendingThinking : undefined,
            thinkingExtracted: pendingThinking.length > 0 || undefined,
          });
        }
        pendingThinking = [];
        continue;
      }

      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const toolUseId = block.id ?? messageId;
        messages.push({
          id: messageId,
          timestamp,
          type: 'tool_use',
          content: `Using tool: ${block.name}`,
          metadata: {
            name: block.name,
            id: toolUseId,
            input: block.input ?? {},
          },
        });
      }
      continue;
    }

    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      messages.push({ id: messageId, timestamp, type: 'user', content: block.text.trim() });
      continue;
    }

    if (block.type === 'tool_result') {
      const toolUseId = block.tool_use_id;
      messages.push({
        id: messageId,
        timestamp,
        type: 'tool_result',
        content: extractToolResultText(block.content),
        metadata: {
          ...(toolUseId ? { tool_use_id: toolUseId } : {}),
          ...(typeof block.is_error === 'boolean' ? { is_error: block.is_error } : {}),
        },
      });
    }
  }

  if (pendingThinking.length > 0) {
    messages.push({
      id: `${baseId}:thinking`,
      timestamp,
      type: 'assistant',
      content: '',
      thinking: pendingThinking,
      thinkingExtracted: true,
    });
  }

  return messages;
}

export async function parseClaudeJsonlTranscript(
  filePath: string,
  options: ClaudeJsonlTranscriptParseOptions = {},
): Promise<ImportedTranscript | null> {
  return (await parseClaudeJsonlTranscriptDetailed(filePath, options)).transcript;
}

export async function parseClaudeJsonlTranscriptDetailed(
  filePath: string,
  options: ClaudeJsonlTranscriptParseOptions = {},
): Promise<ClaudeJsonlTranscriptParseResult> {
  let sessionId = '';
  let workingDirectory = '';
  let createdAt = 0;
  let endedAt = 0;
  const messages: OutputMessage[] = [];
  const entrypoints = new Set<string>();
  let firstUserMessage = '';
  let lastUserMessage = '';

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: ClaudeJsonlLine;
      try {
        parsed = JSON.parse(line) as ClaudeJsonlLine;
      } catch {
        continue;
      }

      if (parsed.isSidechain) continue;

      const tsRaw = parsed.timestamp;
      const ts = tsRaw ? Date.parse(tsRaw) : NaN;

      if (parsed.sessionId && !sessionId) sessionId = parsed.sessionId;
      if (parsed.cwd && !workingDirectory) workingDirectory = parsed.cwd;
      if (parsed.entrypoint?.trim()) entrypoints.add(parsed.entrypoint.trim());

      if (Number.isFinite(ts)) {
        if (createdAt === 0 || ts < createdAt) createdAt = ts;
        if (ts > endedAt) endedAt = ts;
      }

      const lineType = parsed.type;
      if (lineType !== 'user' && lineType !== 'assistant') continue;
      const timestamp = Number.isFinite(ts) ? ts : Date.now();

      if (options.preserveToolMessages) {
        const structuredMessages = extractStructuredMessages(parsed, lineType, timestamp);
        messages.push(...structuredMessages);

        for (const message of structuredMessages) {
          if (message.type !== 'user') continue;
          if (!firstUserMessage) firstUserMessage = message.content;
          lastUserMessage = message.content;
        }
        continue;
      }

      const content = extractTextFromContentBlocks(parsed.message?.content);
      if (!content) continue;

      const id = parsed.uuid ?? globalThis.crypto.randomUUID();
      const outType: OutputMessage['type'] = lineType === 'user' ? 'user' : 'assistant';

      messages.push({ id, timestamp, type: outType, content });

      if (lineType === 'user') {
        if (!firstUserMessage) firstUserMessage = content;
        lastUserMessage = content;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  const sortedEntryPoints = Array.from(entrypoints).sort();
  if (
    entrypoints.size > 0
    && !entrypoints.has('cli')
    && options.allowNonMainEntrypoint !== true
  ) {
    return {
      transcript: null,
      sessionId,
      entrypoints: sortedEntryPoints,
      skipReason: 'non-main-entrypoint',
    };
  }
  if (!sessionId || messages.length === 0 || !firstUserMessage) {
    return {
      transcript: null,
      sessionId,
      entrypoints: sortedEntryPoints,
      skipReason: 'empty',
    };
  }

  return {
    transcript: {
      sessionId,
      workingDirectory,
      createdAt: createdAt || Date.now(),
      endedAt: endedAt || Date.now(),
      messages,
      firstUserMessage,
      lastUserMessage,
    },
    sessionId,
    entrypoints: sortedEntryPoints,
  };
}
