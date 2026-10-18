import * as fsp from 'node:fs/promises';
import type { LoopStage } from '../../shared/types/loop.types';
import { readUtf8FileTail } from './bounded-file-read';
import { ITERATION_LOG_MAX_BYTES, ITERATION_LOG_KEEP_TAIL_BYTES, trimIterationLogTail } from './loop-stage-markdown';

export interface IterationLogEntry {
  seq: number;
  stage: LoopStage;
  verdict: 'OK' | 'WARN' | 'CRITICAL';
  tokens: number;
  durationMs: number;
  filesChanged: number;
  progressNotes: string[];
  completionNotes: string[];
}

export async function appendBoundedIterationLog(logPath: string, entry: IterationLogEntry): Promise<void> {
  const previous = await readUtf8FileTail(logPath, ITERATION_LOG_MAX_BYTES).catch(() => undefined);
  const lines = [
    `## Iteration ${entry.seq + 1} — ${entry.stage} — ${entry.verdict}`,
    `- duration: ${(entry.durationMs / 1000).toFixed(1)}s`,
    `- tokens: ${entry.tokens}`,
    `- files changed: ${entry.filesChanged}`,
  ];
  for (const [label, notes] of [['progress signals', entry.progressNotes], ['completion signals fired', entry.completionNotes]] as const) {
    if (notes.length === 0) continue;
    const entries = previous?.text.split('\n## Iteration ').slice(1) ?? [];
    // A repeated marker refers back to the nearest full block of the same kind.
    const last = entries.at(-1) ?? previous?.text ?? '';
    let block = last.match(new RegExp(`^- ${label}:\\n((?:  - .*\\n)+)`, 'm'))?.[1];
    if (last.includes(`- ${label}: same as previous iteration`)) {
      for (const old of entries.slice(0, -1).reverse()) {
        block = old.match(new RegExp(`^- ${label}:\\n((?:  - .*\\n)+)`, 'm'))?.[1];
        if (block || !old.includes(`- ${label}: same as previous iteration`)) break;
      }
    }
    const full = notes.map((note) => `  - ${note}\n`).join('');
    lines.push(block === full ? `- ${label}: same as previous iteration` : `- ${label}:\n${full.trimEnd()}`);
  }
  await fsp.appendFile(logPath, lines.join('\n') + '\n\n', 'utf8');
  if ((await fsp.stat(logPath)).size > ITERATION_LOG_MAX_BYTES) {
    const tail = await readUtf8FileTail(logPath, ITERATION_LOG_KEEP_TAIL_BYTES);
    await fsp.writeFile(logPath, trimIterationLogTail(tail.text), 'utf8');
  }
}
