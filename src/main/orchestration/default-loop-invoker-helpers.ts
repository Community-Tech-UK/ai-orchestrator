import { createHash } from 'crypto';
import type { LoopErrorRecord, LoopProvider } from '../../shared/types/loop.types';
import { getDefaultModelForCli } from '../../shared/types/provider.types';
import { resolveCliType } from '../cli/adapters/adapter-factory';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';

export function enableAdapterResume(adapter: unknown): void {
  const setResume = (adapter as { setResume?: (resume: boolean) => void } | null | undefined)?.setResume;
  if (typeof setResume === 'function') setResume.call(adapter, true);
}

export async function createPersistentLoopAdapter(opts: {
  provider: LoopProvider;
  workingDirectory: string;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  env?: Record<string, string>;
}): Promise<unknown> {
  const cliType = await resolveCliType(opts.provider as Parameters<typeof resolveCliType>[0], 'claude');
  const model = getDefaultModelForCli(cliType);
  const adapter = getProviderRuntimeService().createAdapter({
    cliType,
    options: {
      workingDirectory: opts.workingDirectory,
      model,
      yoloMode: true,
      timeout: opts.timeoutMs ?? 30 * 60 * 1000,
      env: opts.env,
    },
  });
  if (typeof opts.streamIdleTimeoutMs === 'number') {
    const setter = (adapter as { setStreamIdleTimeoutMs?: (ms: number) => void }).setStreamIdleTimeoutMs;
    if (typeof setter === 'function') setter.call(adapter, opts.streamIdleTimeoutMs);
  }
  return adapter;
}

export function parseTestCounts(output: string): { pass: number | null; fail: number | null } {
  if (!output) return { pass: null, fail: null };
  let pass: number | null = null;
  let fail: number | null = null;
  const set = (p: number | null, f: number | null): void => {
    if (p !== null) pass = p;
    if (f !== null) fail = f;
  };
  const setFailOnly = (f: number): void => {
    if (!Number.isFinite(f)) return;
    set(pass ?? 0, f);
  };

  for (const m of output.matchAll(/Tests\s+(?:[^\n|]*\|)?\s*(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?/gi)) {
    const p = Number.parseInt(m[1], 10);
    const f = m[2] != null ? Number.parseInt(m[2], 10) : 0;
    if (Number.isFinite(p)) set(p, f);
  }
  for (const line of output.split(/\r?\n/)) {
    if (/\bpassed\b/i.test(line)) continue;
    const m = line.match(/^\s*Tests\s+(\d+)\s+failed\b/i);
    if (m) setFailOnly(Number.parseInt(m[1], 10));
  }

  for (const m of output.matchAll(/Tests:\s+(?:(\d+)\s+failed,?\s+)?(?:\d+\s+skipped,?\s+)?(\d+)\s+passed,?\s+\d+\s+total/gi)) {
    const f = m[1] != null ? Number.parseInt(m[1], 10) : 0;
    const p = Number.parseInt(m[2], 10);
    if (Number.isFinite(p)) set(p, f);
  }
  for (const m of output.matchAll(/Tests:\s+(\d+)\s+failed,?\s+\d+\s+total/gi)) {
    setFailOnly(Number.parseInt(m[1], 10));
  }

  for (const m of output.matchAll(/={3,}[^=\n]*?\b(\d+)\s+passed\b(?:[^=\n]*?\b(\d+)\s+failed\b)?[^=\n]*={3,}/gi)) {
    const p = Number.parseInt(m[1], 10);
    const f = m[2] != null ? Number.parseInt(m[2], 10) : 0;
    if (Number.isFinite(p)) set(p, f);
  }
  for (const line of output.split(/\r?\n/)) {
    if (/\bpassed\b/i.test(line)) continue;
    const m = line.match(/={3,}[^=\n]*?\b(\d+)\s+failed\b[^=\n]*={3,}/i);
    if (m) setFailOnly(Number.parseInt(m[1], 10));
  }

  for (const m of output.matchAll(/(\d+)\s+passing\b/gi)) {
    const p = Number.parseInt(m[1], 10);
    if (Number.isFinite(p)) set(p, fail);
  }
  for (const m of output.matchAll(/(\d+)\s+failing\b/gi)) {
    const f = Number.parseInt(m[1], 10);
    if (Number.isFinite(f)) set(pass ?? 0, f);
  }

  for (const m of output.matchAll(/test result:[^\n]*?(\d+)\s+passed;\s*(\d+)\s+failed/gi)) {
    const p = Number.parseInt(m[1], 10);
    const f = Number.parseInt(m[2], 10);
    if (Number.isFinite(p)) set(p, f);
  }

  return { pass, fail };
}

export function classifyIterationErrors(output: string): LoopErrorRecord[] {
  if (!output) return [];
  const records: LoopErrorRecord[] = [];
  const seen = new Set<string>();
  const push = (bucket: string, excerpt: string): void => {
    const hash = createHash('sha256').update(`${bucket}:${excerpt}`).digest('hex').slice(0, 16);
    if (seen.has(hash)) return;
    seen.add(hash);
    records.push({ bucket, exactHash: hash, excerpt: excerpt.slice(0, 512) });
  };
  const MAX = 10;
  for (const m of output.matchAll(/(?:^|\n).{0,40}(?:error\s+)?TS(\d{3,5})[:\s][^\n]{0,200}/gi)) {
    push(`ts-${m[1]}`, m[0].trim());
    if (records.length >= MAX) return records;
  }
  for (const m of output.matchAll(/\b\d+:\d+\s+error\s+[^\n]{0,200}/gi)) {
    push('eslint', m[0].trim());
    if (records.length >= MAX) return records;
  }
  for (const m of output.matchAll(/(?:^|\n)([A-Z][A-Za-z]*Error|Exception):\s[^\n]{0,200}/gm)) {
    push(`runtime-${m[1].toLowerCase()}`, m[0].trim());
    if (records.length >= MAX) return records;
  }
  for (const m of output.matchAll(/(?:^|\n)[^\n]{0,40}\b(FAILED|failed:)[^\n]{0,200}/g)) {
    push('test-failure', m[0].trim());
    if (records.length >= MAX) return records;
  }
  return records;
}
