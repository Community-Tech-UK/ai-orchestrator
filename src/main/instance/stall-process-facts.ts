import { execFile } from 'node:child_process';
import { basename, extname } from 'node:path';
import { redactSecrets } from '../security/secret-detector';

export type StallProcessState = 'running' | 'sleeping' | 'disk-wait' | 'stopped' | 'zombie' | 'unknown';
export interface StallProcessFacts {
  pid: number;
  state: StallProcessState;
  cpuPercent: number | null;
  rssMb: number;
  child: { label: string; runningSeconds: number; cpuPercent: number | null } | null;
  sampledAt: number;
}
export interface StallProcessSampleOptions {
  silenceMs: number;
  runPs?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  now?: () => number;
}

interface ProcessSample {
  pid: number;
  ppid: number;
  state: StallProcessState;
  cpuSeconds: number;
  runningSeconds: number;
  rssMb: number;
  label: string;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby']);
const SAMPLE_GAP_MS = 1500;
const OVERALL_CAP_MS = 5000;

/** Two read-only ps observations. Never signals, stops or changes the process. */
export async function sampleStallProcessFacts(
  pid: number | null,
  options: StallProcessSampleOptions,
): Promise<StallProcessFacts | null> {
  if (pid === null || !Number.isInteger(pid) || pid <= 1 || (options.platform ?? process.platform) === 'win32') return null;
  const runPs = options.runPs ?? readProcessTable;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { expired = true; resolve(null); }, OVERALL_CAP_MS);
  });
  const collect = async (): Promise<StallProcessFacts | null> => {
    try {
      const first = parseProcessTable(await runPs());
      const firstAt = now();
      const processFirst = first.get(pid);
      if (!processFirst || expired) return null;
      await sleep(SAMPLE_GAP_MS);
      if (expired) return null;
      const second = parseProcessTable(await runPs());
      const sampledAt = now();
      if (expired) return null;
      const processSecond = second.get(pid);
      const current = processSecond ?? processFirst;
      const wallSeconds = (sampledAt - firstAt) / 1000;
      const child = processSecond ? selectChild(second, pid, options.silenceMs) : null;
      return {
        pid, state: processSecond?.state ?? 'unknown', cpuPercent: cpuPercent(processFirst, processSecond, wallSeconds),
        rssMb: current.rssMb, sampledAt,
        child: child ? {
          label: child.label, runningSeconds: child.runningSeconds,
          cpuPercent: cpuPercent(first.get(child.pid), second.get(child.pid), wallSeconds),
        } : null,
      };
    } catch { return null; }
  };
  try { return await Promise.race([collect(), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function readProcessTable(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-A', '-ww', '-o', 'pid,ppid,stat,time,etime,rss,command'], {
      timeout: 2000, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
  });
}

function parseProcessTable(table: string): Map<number, ProcessSample> {
  const rows = new Map<number, ProcessSample>();
  for (const line of table.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    if (!match) continue; // Header and malformed rows cannot become facts.
    const [, rawPid, rawPpid, stat, time, elapsed, rss, command] = match;
    const cpuSeconds = durationSeconds(time);
    const runningSeconds = durationSeconds(elapsed);
    if (cpuSeconds === null || runningSeconds === null) continue;
    const pid = Number(rawPid);
    // Only the sanitized label survives parsing; raw command lines are never retained.
    rows.set(pid, { pid, ppid: Number(rawPpid), state: processState(stat), cpuSeconds,
      runningSeconds, rssMb: Number(rss) / 1024, label: sanitizeProcessLabel(command) });
  }
  return rows;
}

function durationSeconds(value: string): number | null {
  const match = value.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
}

function processState(stat: string): StallProcessState {
  switch (stat[0]) {
    case 'R': return 'running';
    case 'S': case 'I': return 'sleeping';
    case 'D': case 'U': return 'disk-wait';
    case 'T': case 't': return 'stopped';
    case 'Z': return 'zombie';
    default: return 'unknown';
  }
}

function cpuPercent(first: ProcessSample | undefined, second: ProcessSample | undefined, wallSeconds: number): number | null {
  if (!first || !second || wallSeconds <= 0 || second.cpuSeconds < first.cpuSeconds) return null;
  return Math.round((second.cpuSeconds - first.cpuSeconds) / wallSeconds * 100);
}

export function sanitizeProcessLabel(command: string): string {
  const tokens = (command.match(/"[^"\n]*"|'[^'\n]*'|\S+/g) ?? []).map((token) => token.replace(/^['"]|['"]$/g, ''));
  const program = basename(tokens.shift() ?? '').replace(/^-/, '');
  if (SHELLS.has(program)) return 'a shell command';
  // Stop at the first flag, rather than treating a flag's value as an ordinary argument.
  const firstFlag = tokens.findIndex((arg) => arg.startsWith('-'));
  const args = tokens.slice(0, firstFlag === -1 ? tokens.length : firstFlag);
  let label = program;
  if (INTERPRETERS.has(program) && args.length) {
    const script = basename(args.shift()!);
    label = script.slice(0, script.length - extname(script).length);
  }
  const shortArgs = args.filter((arg) => arg.length <= 30 && !arg.includes('=') && !arg.includes('://')).slice(0, 2);
  return [...redactSecrets([label, ...shortArgs].join(' '))]
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').slice(0, 60);
}

function selectChild(rows: Map<number, ProcessSample>, pid: number, silenceMs: number): ProcessSample | null {
  const children = new Map<number, ProcessSample[]>();
  for (const row of rows.values()) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const descendants: ProcessSample[] = [];
  const visited = new Set([pid]);
  const queue = [...(children.get(pid) ?? [])];
  for (const child of queue) {
    if (visited.has(child.pid)) continue;
    visited.add(child.pid);
    descendants.push(child);
    queue.push(...(children.get(child.pid) ?? []));
  }
  const eligible = descendants.filter((child) => child.runningSeconds <= Math.max(0, silenceMs) / 1000 + 20);
  const eligiblePids = new Set(eligible.map((child) => child.pid));
  const oldest = (choices: ProcessSample[]) => choices.sort((a, b) => b.runningSeconds - a.runningSeconds || a.pid - b.pid)[0];
  let candidate = oldest(eligible.filter((child) => !eligiblePids.has(child.ppid)));
  if (!candidate) return null;
  for (;;) {
    const next = oldest((children.get(candidate.pid) ?? []).filter((child) => eligiblePids.has(child.pid)));
    if (!next) return candidate;
    candidate = next;
  }
}

/** One wording seam for Phase 3 and the process inspector. */
export function describeStallProcessFacts(facts: StallProcessFacts): string {
  const prefix = 'Harness checked the process: ';
  let description: string;
  if (facts.state === 'stopped') description = 'it has been paused by the system, so it cannot continue until it is resumed.';
  else if (facts.state === 'zombie') description = 'it has already exited and is only waiting to be cleaned up.';
  else if (facts.state === 'disk-wait') description = 'it is waiting on the disk or network and cannot respond until that finishes.';
  else if ((facts.cpuPercent ?? 0) >= 80) description = `it is busy, using ${facts.cpuPercent}% of a CPU, but has produced no output.`;
  else if (facts.child) {
    const age = facts.child.runningSeconds >= 60 ? `${Math.floor(facts.child.runningSeconds / 60)} min` : `${Math.floor(facts.child.runningSeconds)} s`;
    const cpu = facts.child.cpuPercent === null ? 'CPU use could not be measured' : `using ${facts.child.cpuPercent}% of a CPU`;
    description = `it is waiting on "${facts.child.label}", a program it started ${age} ago (${cpu}).`;
  } else if (facts.cpuPercent === null) description = 'it was present in the first check, but CPU use could not be measured in the second check.';
  else description = 'it is alive and using almost no CPU, and has not started anything else. It is probably waiting for a reply from the model.';
  const memory = facts.rssMb >= 4096 ? ` It is using ${(facts.rssMb / 1024).toFixed(1)} GB of memory.` : '';
  return prefix + description + memory;
}

export function isNotableStallFact(facts: StallProcessFacts): boolean {
  return facts.state === 'stopped' || facts.state === 'zombie' || facts.state === 'disk-wait'
    || (facts.cpuPercent ?? 0) >= 80 || facts.child !== null;
}
