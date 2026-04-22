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
          if (
            entry.type === 'session_meta'
            && typeof entry.cwd === 'string'
            && crossPlatformPathsEqual(entry.cwd, targetCwd)
          ) {
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

  private async streamParseJsonl(filePath: string, targetCwd: string): Promise<CodexSessionScanResult | null> {
    return new Promise((resolve) => {
      let threadId: string | null = null;
      let model: string | null = null;
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
          if (entry.type === 'session_meta') {
            if (
              typeof entry.cwd === 'string'
              && crossPlatformPathsEqual(entry.cwd, targetCwd)
            ) {
              matchesCwd = true;
              model = entry.model ?? null;
            }
          }
          if (entry.threadId && !threadId) {
            threadId = entry.threadId;
          }
          if (entry.type === 'event_msg' && entry.subtype === 'token_count') {
            tokenUsage.input += entry.input_tokens ?? entry.inputTokens ?? 0;
            tokenUsage.output += entry.output_tokens ?? entry.outputTokens ?? 0;
            tokenUsage.cached += entry.cached_tokens ?? entry.cachedTokens ?? 0;
            tokenUsage.reasoning += entry.reasoning_tokens ?? entry.reasoningTokens ?? 0;
          }
        } catch {
          // Skip malformed lines
        }
      });

      rl.on('close', () => {
        if (matchesCwd && threadId) {
          resolve({ threadId, model, sessionFilePath: filePath, workspacePath: targetCwd, tokenUsage, lastModified });
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
