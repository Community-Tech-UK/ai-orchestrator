import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

export function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function writeJsonl(path: string, rows: readonly unknown[]): void {
  ensureDir(path);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

export function appendJsonl(path: string, row: unknown): void {
  ensureDir(path);
  appendFileSync(path, JSON.stringify(row) + '\n');
}

/** Runs `worker` over `items` with at most `concurrency` in flight. Results are not collected; workers write their own output. */
export async function forEachLimited<T>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
}

export interface ParsedArgs { positional: string[]; flags: Map<string, string> }

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags.set(arg.slice(2), 'true');
      else { flags.set(arg.slice(2), next); i += 1; }
    } else positional.push(arg);
  }
  return { positional, flags };
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (!value || value === 'true') throw new Error(`missing --${name}`);
  return value;
}

export function numberFlag(args: ParsedArgs, name: string, fallback: number): number {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number`);
  return n;
}
