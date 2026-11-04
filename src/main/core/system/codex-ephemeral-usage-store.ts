import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { CodexEphemeralUsageSchema } from '../../../shared/validation/codex-ephemeral-usage.schemas';
import type { CodexEphemeralUsage, CodexEphemeralUsageResult } from '../../../shared/types/codex-ephemeral-usage.types';

const MAX_BYTES = 2 * 1024 * 1024;
const ROTATIONS = 2;
export function codexEphemeralUsageFile(): string {
  return join(app.getPath('userData'), 'logs', 'codex-ephemeral-usage.jsonl');
}
/** Main-process synchronous append: a normal runtime stop must not lose the receipt. */
export function appendCodexEphemeralUsage(row: CodexEphemeralUsage, file = codexEphemeralUsageFile()): void {
  const serialized = JSON.stringify(CodexEphemeralUsageSchema.parse(row)) + '\n';
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && statSync(file).size + Buffer.byteLength(serialized) > MAX_BYTES) {
    for (let index = ROTATIONS - 1; index >= 0; index--) {
      const source = index === 0 ? file : `${file}.${index}`;
      if (existsSync(source)) renameSync(source, `${file}.${index + 1}`);
    }
  }
  const fd = openSync(file, 'a+', 0o600);
  try {
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(1);
    if (size > 0 && readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] !== 10) appendFileSync(fd, '\n');
    appendFileSync(fd, serialized, 'utf8'); fsyncSync(fd);
  } finally { closeSync(fd); }
}
/** Bounded tail reads; never read a growing file unboundedly or accept an unfinished line. */
export function readCodexEphemeralUsage(file = codexEphemeralUsageFile(), limit = 100): CodexEphemeralUsageResult {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid usage limit');
  const result: CodexEphemeralUsageResult = { entries: [], truncated: false, skippedLines: 0 };
  const seen = new Set<string>();
  for (let index = 0; index <= ROTATIONS; index++) {
    const source = index === 0 ? file : `${file}.${index}`;
    let fd: number;
    try { fd = openSync(source, 'r'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let text: string;
    let offset: number;
    try {
      const size = fstatSync(fd).size;
      offset = Math.max(0, size - MAX_BYTES);
      const buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      text = buffer.subarray(0, read).toString('utf8');
    } finally { closeSync(fd); }
    if (offset > 0) { text = text.slice(text.indexOf('\n') + 1); result.truncated = true; }
    const lines = text.split('\n');
    if (lines.pop()) result.skippedLines++; // Incomplete final JSON is never a receipt.
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
      const line = lines[lineIndex];
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 16384) { result.skippedLines++; continue; }
      let value: unknown;
      try { value = JSON.parse(line); } catch { result.skippedLines++; continue; }
      const parsed = CodexEphemeralUsageSchema.safeParse(value);
      if (!parsed.success) { result.skippedLines++; continue; }
      if (seen.has(parsed.data.threadId)) continue;
      seen.add(parsed.data.threadId);
      if (result.entries.length >= limit) { result.truncated = true; continue; }
      result.entries.push(parsed.data);
    }
  }
  return result;
}
