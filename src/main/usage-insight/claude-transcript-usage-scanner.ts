/**
 * Reads the last 7 days of Claude transcripts into request facts, a bounded
 * piece at a time.
 *
 * - Only files touched inside the window are opened.
 * - Files are streamed in 1 MiB chunks and handed back to the event loop every
 *   few milliseconds, so the app stays responsive while a big folder is read.
 * - A file's digest remembers how far it was read. A transcript only ever grows,
 *   so a later refresh reads just the new bytes and carries on from the saved
 *   state.
 * - Limits on file size, line size, file count and request count mean one huge
 *   transcript cannot stall or exhaust the app. Anything left out is counted and
 *   reported, never dropped silently.
 *
 * Only token counts, timestamps, session ids, model names and tool-result sizes
 * are kept. No message text is stored.
 */

import {
  CONTEXT_RESET_FRACTION,
  USAGE_WINDOW_MS,
} from '../../shared/usage-insight/usage-cause-rules';
import type {
  UsageInsightNote,
  UsageRequestFact,
  UsageScanProgress,
} from '../../shared/usage-insight/usage-insight.types';
import { discoverTranscriptFiles, type TranscriptFile } from './claude-transcript-files';
import { streamLines } from './jsonl-line-stream';
import {
  MAX_PARSE_LINE_CHARS,
  oversizedLineEvent,
  parseTranscriptLine,
  type TranscriptEvent,
} from './claude-transcript-usage-parser';

const MIB = 1024 * 1024;

export interface ScanLimits {
  maxFiles: number;
  /** Bigger transcripts are skipped and counted. */
  maxFileBytes: number;
  /** All transcripts read together. Newest first; whatever does not fit is skipped and counted. */
  maxTotalBytes: number;
  /** A single line bigger than this is skipped and counted. */
  maxLineBytes: number;
  maxRequests: number;
  chunkBytes: number;
  yieldEveryMs: number;
}

const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxFiles: 4000,
  maxFileBytes: 512 * MIB,
  maxTotalBytes: 6 * 1024 * MIB,
  maxLineBytes: 64 * MIB,
  maxRequests: 400_000,
  chunkBytes: MIB,
  yieldEveryMs: 20,
};

export interface ScannerOptions {
  roots: () => string[];
  now?: () => number;
  windowMs?: number;
  limits?: Partial<ScanLimits>;
}

export interface TranscriptScan {
  requests: UsageRequestFact[];
  /** Prompt size of each session's first request, by session id. */
  sessionStarts: Map<string, number>;
  notes: UsageInsightNote[];
}

interface ScannedRequest {
  key: string | null;
  sessionId: string;
  at: number;
  model: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  helper: boolean;
  bigResult: boolean;
}

/** What the scanner remembers about one conversation thread (the main chat, or one helper). */
interface StreamState {
  lastPrompt: number;
  bigTokens: number;
  lastKey: string | null;
  last: ScannedRequest | null;
}

interface FileDigest {
  path: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  ino: number;
  /** Bytes read so far, always the end of a complete line. */
  offset: number;
  fileSessionId: string;
  requests: ScannedRequest[];
  /** Older requests dropped from `requests` to keep within the budget. */
  trimmedRequests: number;
  streams: Map<string, StreamState>;
  startPromptTokens?: number;
  startSessionId?: string;
  startAt?: number;
  firstRequestAt?: number;
  skippedLines: number;
}

function createDigest(file: TranscriptFile): FileDigest {
  return {
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    birthtimeMs: file.birthtimeMs,
    ino: file.ino,
    offset: 0,
    fileSessionId: file.fileSessionId,
    requests: [],
    trimmedRequests: 0,
    streams: new Map<string, StreamState>(),
    skippedLines: 0,
  };
}

function streamOf(digest: FileDigest, sidechain: boolean, agentId: string | null): StreamState {
  const key = sidechain ? `side:${agentId ?? ''}` : 'main';
  let state = digest.streams.get(key);
  if (!state) {
    state = { lastPrompt: 0, bigTokens: 0, lastKey: null, last: null };
    digest.streams.set(key, state);
  }
  return state;
}

/** Folds one parsed line into the digest. */
function applyTranscriptEvent(digest: FileDigest, event: TranscriptEvent, windowStart: number, maxRequests: number): void {
  switch (event.kind) {
    case 'request': {
      const stream = streamOf(digest, event.sidechain, event.agentId);
      const prompt = event.input + event.cacheWrite + event.cacheRead;
      if (event.key !== null && event.key === stream.lastKey) {
        // Another content block of the response already counted.
        const last = stream.last;
        if (last) {
          last.input = Math.max(last.input, event.input);
          last.cacheWrite = Math.max(last.cacheWrite, event.cacheWrite);
          last.cacheRead = Math.max(last.cacheRead, event.cacheRead);
          last.output = Math.max(last.output, event.output);
        }
        stream.lastPrompt = Math.max(stream.lastPrompt, prompt);
        return;
      }
      // A prompt that shrank a lot means the chat was cut down, so earlier big
      // results are no longer in it.
      if (stream.lastPrompt > 0 && prompt < CONTEXT_RESET_FRACTION * stream.lastPrompt) stream.bigTokens = 0;
      const bigResult = stream.bigTokens > 0;
      stream.lastPrompt = prompt;
      stream.lastKey = event.key;
      stream.last = null;
      const sessionId = event.sessionId ?? digest.fileSessionId;
      if (!event.sidechain && digest.startPromptTokens === undefined) {
        digest.startPromptTokens = prompt;
        digest.startSessionId = sessionId;
        digest.startAt = event.at;
      }
      if (event.at < windowStart) return;
      const request: ScannedRequest = {
        key: event.key,
        sessionId,
        at: event.at,
        model: event.model,
        input: event.input,
        cacheWrite: event.cacheWrite,
        cacheRead: event.cacheRead,
        output: event.output,
        helper: event.sidechain,
        bigResult,
      };
      digest.requests.push(request);
      // Retention keeps the same budget the report trims to: the newest
      // requests only, so a long-lived transcript cannot grow without limit.
      if (digest.requests.length > maxRequests) {
        const excess = digest.requests.length - maxRequests;
        digest.requests.splice(0, excess);
        digest.trimmedRequests += excess;
      }
      stream.last = request;
      if (digest.firstRequestAt === undefined || event.at < digest.firstRequestAt) digest.firstRequestAt = event.at;
      return;
    }
    case 'tool-results':
      if (event.bigTokens > 0) streamOf(digest, event.sidechain, event.agentId).bigTokens += event.bigTokens;
      return;
    case 'compaction':
      for (const stream of digest.streams.values()) {
        stream.bigTokens = 0;
        stream.lastPrompt = 0;
      }
      return;
    case 'invalid':
      digest.skippedLines += 1;
      return;
    case 'other':
      return;
  }
}

/** A line must contain one of these to be worth decoding; checked on the raw bytes. */
const GATES = ['"usage"', '"tool_result"', 'compact_boundary', '"compactMetadata"', '"isCompactSummary"']
  .map((text) => Buffer.from(text));
const TOOL_RESULT = Buffer.from('"tool_result"');

export class ClaudeTranscriptScanner {
  private readonly digests = new Map<string, FileDigest>();
  private readonly limits: ScanLimits;
  private skippedLarge = 0;
  private skippedLimit = 0;
  /** Files whose last read failed. Tried again on the next refresh, and reported until they read. */
  private readonly unreadable = new Set<string>();

  constructor(private readonly options: ScannerOptions) {
    this.limits = { ...DEFAULT_SCAN_LIMITS, ...options.limits };
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Reads whatever is new since the last call. Safe to call again after an abort. */
  async refresh(onProgress?: (progress: UsageScanProgress) => void, signal?: AbortSignal): Promise<void> {
    const windowStart = this.now() - (this.options.windowMs ?? USAGE_WINDOW_MS);
    const found = await discoverTranscriptFiles(this.options.roots(), windowStart);

    const eligible: TranscriptFile[] = [];
    this.skippedLarge = 0;
    for (const file of found) {
      if (file.size > this.limits.maxFileBytes) this.skippedLarge += 1;
      else eligible.push(file);
    }
    // Newest first, until the file count or the total size budget is used up.
    const files: TranscriptFile[] = [];
    let budget = this.limits.maxTotalBytes;
    this.skippedLimit = 0;
    for (const file of eligible) {
      if (files.length >= this.limits.maxFiles || file.size > budget) {
        this.skippedLimit += 1;
        continue;
      }
      budget -= file.size;
      files.push(file);
    }

    const present = new Set(files.map((file) => file.path));
    for (const path of this.digests.keys()) {
      if (!present.has(path)) this.digests.delete(path);
    }
    for (const path of this.unreadable) {
      if (!present.has(path)) this.unreadable.delete(path);
    }

    const work: { file: TranscriptFile; digest: FileDigest }[] = [];
    for (const file of files) {
      let digest = this.digests.get(file.path);
      if (digest && (file.ino !== digest.ino || file.size < digest.offset)) digest = undefined;
      if (!digest) {
        digest = createDigest(file);
        this.digests.set(file.path, digest);
      }
      digest.size = file.size;
      digest.mtimeMs = file.mtimeMs;
      // Requests age out of the window while the transcript stays open; the
      // report must not keep counting them or holding their memory.
      if (digest.requests.length > 0 && digest.requests[0].at < windowStart) {
        digest.requests = digest.requests.filter((request) => request.at >= windowStart);
      }
      // Work is "bytes not read yet", not "file changed": a pass that was
      // aborted leaves a half-read file that must be finished next time.
      if (file.size > digest.offset) work.push({ file, digest });
    }

    const progress: UsageScanProgress = {
      filesDone: 0,
      filesTotal: work.length,
      bytesDone: 0,
      bytesTotal: work.reduce((sum, item) => sum + (item.file.size - item.digest.offset), 0),
    };
    onProgress?.({ ...progress });

    let lastYield = Date.now();
    const yieldIfDue = async (): Promise<void> => {
      if (Date.now() - lastYield < this.limits.yieldEveryMs) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
      lastYield = Date.now();
    };

    for (const { digest } of work) {
      if (signal?.aborted) return;
      try {
        await this.readFile(digest, windowStart, async (bytes) => {
          progress.bytesDone += bytes;
          await yieldIfDue();
        }, signal);
        this.unreadable.delete(digest.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Gone since the folder was listed: nothing to report.
          this.digests.delete(digest.path);
          this.unreadable.delete(digest.path);
        } else {
          // Left out of this pass, and reported so the gap is visible.
          this.unreadable.add(digest.path);
        }
      }
      progress.filesDone += 1;
      onProgress?.({ ...progress });
    }
  }

  private async readFile(
    digest: FileDigest,
    windowStart: number,
    onChunk: (bytes: number) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    await streamLines(digest.path, {
      start: digest.offset,
      chunkBytes: this.limits.chunkBytes,
      maxLineBytes: this.limits.maxLineBytes,
      signal,
      onLine: (line, endOffset) => {
        if (line === null) digest.skippedLines += 1;
        else this.handleLine(digest, line, windowStart);
        digest.offset = endOffset;
      },
      onChunk,
    });
  }

  private handleLine(digest: FileDigest, line: Buffer, windowStart: number): void {
    if (line.length === 0) return;
    if (!GATES.some((gate) => line.includes(gate))) return;
    // A line too big to decode is judged by its size alone, without making a string of it.
    const event: TranscriptEvent = line.length > MAX_PARSE_LINE_CHARS
      ? oversizedLineEvent(line.length, line.includes(TOOL_RESULT))
      : parseTranscriptLine(line.toString('utf8'));
    applyTranscriptEvent(digest, event, windowStart, this.limits.maxRequests);
  }

  /** The merged view of everything read so far. */
  collect(): TranscriptScan {
    const ordered = [...this.digests.values()].sort((a, b) =>
      (a.firstRequestAt ?? Number.MAX_SAFE_INTEGER) - (b.firstRequestAt ?? Number.MAX_SAFE_INTEGER)
      || a.birthtimeMs - b.birthtimeMs
      || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const seen = new Set<string>();
    let requests: UsageRequestFact[] = [];
    const starts = new Map<string, { at: number; tokens: number }>();
    let skippedLines = 0;
    let trimmedRequests = 0;
    for (const digest of ordered) {
      skippedLines += digest.skippedLines;
      trimmedRequests += digest.trimmedRequests;
      if (digest.startPromptTokens !== undefined && digest.startSessionId && digest.startAt !== undefined) {
        const existing = starts.get(digest.startSessionId);
        if (!existing || digest.startAt < existing.at) {
          starts.set(digest.startSessionId, { at: digest.startAt, tokens: digest.startPromptTokens });
        }
      }
      for (const request of digest.requests) {
        // A resumed or forked session copies earlier lines into a new file.
        if (request.key !== null) {
          if (seen.has(request.key)) continue;
          seen.add(request.key);
        }
        requests.push({
          sessionId: request.sessionId,
          at: request.at,
          model: request.model,
          input: request.input,
          cacheWrite: request.cacheWrite,
          cacheRead: request.cacheRead,
          output: request.output,
          helper: request.helper,
          bigResult: request.bigResult,
        });
      }
    }

    const notes: UsageInsightNote[] = [];
    if (this.skippedLarge > 0) notes.push({ code: 'files-skipped-large', count: this.skippedLarge });
    if (this.skippedLimit > 0) notes.push({ code: 'files-skipped-limit', count: this.skippedLimit });
    if (skippedLines > 0) notes.push({ code: 'lines-skipped', count: skippedLines });
    if (this.unreadable.size > 0) notes.push({ code: 'files-unreadable', count: this.unreadable.size });
    if (requests.length > this.limits.maxRequests) {
      requests.sort((a, b) => a.at - b.at);
      trimmedRequests += requests.length - this.limits.maxRequests;
      requests = requests.slice(requests.length - this.limits.maxRequests);
    }
    if (trimmedRequests > 0) notes.push({ code: 'requests-trimmed', count: trimmedRequests });

    return {
      requests,
      sessionStarts: new Map([...starts].map(([sessionId, start]) => [sessionId, start.tokens] as const)),
      notes,
    };
  }

}
