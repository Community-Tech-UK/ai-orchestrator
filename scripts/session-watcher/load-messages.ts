import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { ConversationData } from '../../src/shared/types/history.types';
import type { OutputMessage } from '../../src/shared/types/instance.types';
import { findStops, toStopRef } from './stop-finder';
import { transcriptToMessages } from './transcript-to-messages';
import type { StopRef } from './types';

export function readArchiveFile(file: string): ConversationData {
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as ConversationData;
}

export function readTranscriptMessages(file: string): OutputMessage[] {
  const lines: unknown[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line[0] !== '{') continue;
    try { lines.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return transcriptToMessages(lines);
}

interface LoadedConversation { messages: OutputMessage[]; workingDirectory: string }

const cache = new Map<string, LoadedConversation>();
function conversationOf(ref: StopRef): LoadedConversation {
  if (ref.messages) return { messages: ref.messages, workingDirectory: '' };
  let loaded = cache.get(ref.file);
  if (!loaded) {
    if (ref.source === 'archive') {
      const data = readArchiveFile(ref.file);
      loaded = { messages: data.messages, workingDirectory: data.entry.workingDirectory ?? '' };
    } else {
      loaded = { messages: readTranscriptMessages(ref.file), workingDirectory: '' };
    }
    if (cache.size >= 8) cache.delete(cache.keys().next().value as string);
    cache.set(ref.file, loaded);
  }
  return loaded;
}
function messagesOf(ref: StopRef): OutputMessage[] {
  return conversationOf(ref).messages;
}

/** The session's folder as the archive recorded it; empty for transcripts and written asks, which do not keep one. */
export function workingDirectoryOf(ref: StopRef): string {
  return conversationOf(ref).workingDirectory;
}

/** The conversation up to and including the stopping message; never what came next. */
export function loadMessagesUpToStop(ref: StopRef): OutputMessage[] {
  const all = messagesOf(ref);
  if (ref.stopIndex < 0 || ref.stopIndex >= all.length) throw new Error(`stop index out of range for ${ref.id}`);
  return all.slice(0, ref.stopIndex + 1);
}

export interface ScanCounts { files: number; skippedWithParent: number; stops: number }

/** Every stop in the top-level conversations of an archive folder (entries with a parent are left out). */
export function stopsFromArchive(dir: string): { stops: StopRef[]; counts: ScanCounts } {
  const stops: StopRef[] = [];
  const counts: ScanCounts = { files: 0, skippedWithParent: 0, stops: 0 };
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json.gz')).sort()) {
    const file = join(dir, name);
    const data = readArchiveFile(file);
    counts.files += 1;
    if (data.entry.parentId) { counts.skippedWithParent += 1; continue; }
    for (const found of findStops(data.messages)) {
      stops.push(toStopRef(found, { id: data.entry.id || name.replace(/\.json\.gz$/, ''), source: 'archive', file, provider: String(data.entry.provider ?? 'unknown') }));
    }
  }
  counts.stops = stops.length;
  return { stops, counts };
}

/** Stops in top-level Claude Code transcripts: file modified since `since`, stop time in [since, before). */
export function stopsFromTranscripts(root: string, sinceMs: number, beforeMs: number): { stops: StopRef[]; counts: ScanCounts } {
  const stops: StopRef[] = [];
  const counts: ScanCounts = { files: 0, skippedWithParent: 0, stops: 0 };
  const seen = new Set<string>(); // the same typed line can appear in a resumed session's file too
  for (const project of readdirSync(root).sort()) {
    const dir = join(root, project);
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      try { if (statSync(file).mtimeMs < sinceMs) continue; } catch { continue; }
      counts.files += 1;
      const messages = readTranscriptMessages(file);
      for (const found of findStops(messages)) {
        if (found.stoppedAt < sinceMs || found.stoppedAt >= beforeMs) continue;
        const key = `${found.stoppedAt}|${messages[found.stopIndex].id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        stops.push(toStopRef(found, { id: name.replace(/\.jsonl$/, ''), source: 'transcript', file, provider: 'claude' }));
      }
    }
  }
  counts.stops = stops.length;
  return { stops, counts };
}
