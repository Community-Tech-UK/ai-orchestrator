import { createReadStream, openSync, readSync, closeSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { getLogger } from '../../../logging/logger';
import { crossPlatformPathsEqual } from '../../../../shared/utils/cross-platform-path';

const logger = getLogger('CodexSessionScanner');

export interface CodexSessionScanResult {
  threadId: string;
  model: string | null;
  nativeSourceKind: string | null;
  sessionFilePath: string;
  workspacePath: string;
  tokenUsage: { input: number; output: number; cached: number; reasoning: number };
  lastModified: number;
}

const HEADER_SCAN_BYTES = 4096;

export class CodexSessionScanner {
  private cache = new Map<string, CodexSessionScanResult | null>();
  private sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? join(homedir(), '.codex', 'sessions');
  }

  async findSessionForWorkspace(workspacePath: string): Promise<CodexSessionScanResult | null> {
    if (this.cache.has(workspacePath)) {
      return this.cache.get(workspacePath)!;
    }

    const files = this.collectJsonlFiles();
    for (const filePath of files) {
      if (!this.headerMatchesCwd(filePath, workspacePath)) {
        continue;
      }
      const result = await this.streamParseJsonl(filePath, workspacePath);
      if (result) {
        this.cache.set(workspacePath, result);
        return result;
      }
    }

    this.cache.set(workspacePath, null);
    return null;
  }

  async findSessionByThreadId(threadId: string): Promise<CodexSessionScanResult | null> {
    const files = this.collectJsonlFiles();
    for (const filePath of files) {
      const result = await this.streamParseJsonl(filePath, null, threadId);
      if (result) {
        return result;
      }
    }
    return null;
  }

  invalidateCache(workspacePath: string): void {
    this.cache.delete(workspacePath);
  }

  private collectJsonlFiles(): string[] {
    const files: { path: string; mtime: number }[] = [];

    const walk = (dir: string, depth: number): void => {
      if (depth > 5) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
            files.push({ path: full, mtime: stat.mtimeMs });
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    };

    walk(this.sessionsDir, 0);
    files.sort((a, b) => b.mtime - a.mtime);
    return files.map(f => f.path);
  }

  private headerMatchesCwd(filePath: string, targetCwd: string): boolean {
    let fd: number | null = null;
    try {
      fd = openSync(filePath, 'r');
      const buffer = Buffer.alloc(HEADER_SCAN_BYTES);
      const bytesRead = readSync(fd, buffer, 0, HEADER_SCAN_BYTES, 0);
      const header = buffer.subarray(0, bytesRead).toString('utf8');
      const lines = header.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const payload = asRecord(entry.payload) ?? entry;
          const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
          if (entry.type === 'session_meta' && cwd && crossPlatformPathsEqual(cwd, targetCwd)) {
            return true;
          }
        } catch {
          // Skip malformed lines in header
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
    }
  }

  private async streamParseJsonl(
    filePath: string,
    targetCwd: string | null,
    targetThreadId?: string
  ): Promise<CodexSessionScanResult | null> {
    return new Promise((resolve) => {
      let threadId: string | null = null;
      let model: string | null = null;
      let nativeSourceKind: string | null = null;
      let workspacePath: string | null = null;
      let matchesCwd = false;
      const tokenUsage = { input: 0, output: 0, cached: 0, reasoning: 0 };
      let lastModified = 0;

      try {
        lastModified = statSync(filePath).mtimeMs;
      } catch {
        resolve(null);
        return;
      }

      const rl = createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });

      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const entry = JSON.parse(line);
          const payload = asRecord(entry.payload) ?? entry;
          if (entry.type === 'session_meta') {
            const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
            if (cwd) {
              workspacePath = cwd;
            }
            if (targetCwd === null || (cwd && crossPlatformPathsEqual(cwd, targetCwd))) {
              matchesCwd = true;
              model = (typeof payload.model === 'string' ? payload.model : null)
                ?? (typeof payload.model_provider === 'string' ? payload.model_provider : null);
            }
            nativeSourceKind = normalizeSourceKind(payload.source) ?? nativeSourceKind;
            threadId = (typeof payload.id === 'string' ? payload.id : null) ?? threadId;
          }
          if (entry.type === 'turn_context') {
            model = (typeof payload.model === 'string' ? payload.model : null) ?? model;
            workspacePath = (typeof payload.cwd === 'string' ? payload.cwd : null) ?? workspacePath;
          }
          if (typeof payload.thread_id === 'string' && !threadId) {
            threadId = payload.thread_id;
          }
          if (entry.threadId && !threadId) {
            threadId = entry.threadId;
          }
          const hasNestedPayload = asRecord(entry.payload) !== null;
          const eventType = hasNestedPayload && typeof payload.type === 'string'
            ? payload.type
            : entry.subtype;
          if (entry.type === 'event_msg' && eventType === 'token_count') {
            const info = asRecord(payload.info);
            const total = asRecord(info?.['total_token_usage']) ?? payload;
            tokenUsage.input += numeric(total.input_tokens) ?? numeric(total.inputTokens) ?? 0;
            tokenUsage.output += numeric(total.output_tokens) ?? numeric(total.outputTokens) ?? 0;
            tokenUsage.cached += numeric(total.cached_tokens) ?? numeric(total.cachedTokens) ?? 0;
            tokenUsage.reasoning += numeric(total.reasoning_tokens) ?? numeric(total.reasoningTokens) ?? 0;
          }
        } catch {
          // Skip malformed lines
        }
      });

      rl.on('close', () => {
        const matchesThread = !targetThreadId || threadId === targetThreadId;
        if (matchesCwd && matchesThread && threadId) {
          resolve({
            threadId,
            model,
            nativeSourceKind,
            sessionFilePath: filePath,
            workspacePath: workspacePath ?? targetCwd ?? '',
            tokenUsage,
            lastModified,
          });
        } else {
          resolve(null);
        }
      });

      rl.on('error', (err) => {
        logger.warn('Error reading Codex session file', { filePath, error: String(err) });
        resolve(null);
      });
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeSourceKind(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'subAgent' in value) return 'subAgent';
  return null;
}
