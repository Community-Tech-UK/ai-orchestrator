import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type { OutputMessage } from '../../shared/types/instance.types';

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
  text?: string;
  thinking?: string;
  content?: unknown;
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

export async function parseClaudeJsonlTranscript(filePath: string): Promise<ImportedTranscript | null> {
  return (await parseClaudeJsonlTranscriptDetailed(filePath)).transcript;
}

export async function parseClaudeJsonlTranscriptDetailed(
  filePath: string
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

      const content = extractTextFromContentBlocks(parsed.message?.content);
      if (!content) continue;

      const id = parsed.uuid ?? globalThis.crypto.randomUUID();
      const timestamp = Number.isFinite(ts) ? ts : Date.now();
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
  if (entrypoints.size > 0 && !entrypoints.has('cli')) {
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
