import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { getLogger } from '../logging/logger';

const logger = getLogger('RtkTrialInfo');
let loggedReadFailure = false;

/** Test hook: lets each spec see the once-only failure log again. */
export function _resetRtkTrialInfoForTesting(): void {
  loggedReadFailure = false;
}

/** A missing hook-decisions directory means no hook records, not an unreadable trial. */
async function readHookDecisionNames(hookDir: string): Promise<string[]> {
  try {
    return (await readdir(hookDir)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Every Claude transcript root to scan: the default projects directory plus
 * `<userData>/claude-cli-profiles/<profile>/projects` for each Harness-managed
 * account profile (claude-profile-seed.ts links a profile's `projects` store).
 * Without them the Savings tab's trial counts miss every managed-profile
 * session. Mirrors `transcriptProjectsDirs` in scripts/lib/claude-transcripts.mjs:
 * directories only, no auth/config/credential files read, and an explicit
 * override replaces discovery entirely.
 */
async function transcriptProjectRoots(
  userDataDir: string,
  explicit: string | null | undefined,
): Promise<string[]> {
  if (explicit) return [explicit];
  const roots = [join(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'projects')];
  const profiles = join(userDataDir, 'claude-cli-profiles');
  let entries;
  try {
    entries = await readdir(profiles, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return roots;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projects = join(profiles, entry.name, 'projects');
    try {
      if ((await stat(projects)).isDirectory()) roots.push(projects);
    } catch {
      // A profile without a linked projects store simply has no transcripts.
    }
  }
  return roots;
}

export interface RtkTrialInfo {
  startedAt: string | null;
  sessionsWithHook: number;
  sessionsWithout: number;
}

interface TrialSession {
  arm: 'on' | 'off';
  key: string;
  surface: 'interactive' | 'loop';
  firstTimestamp: number;
}

async function forEachJsonl(file: string, visit: (row: Record<string, unknown>) => void): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row: unknown = JSON.parse(line);
        if (row && typeof row === 'object' && !Array.isArray(row)) visit(row as Record<string, unknown>);
      } catch {
        // A partial line cannot establish a trial assignment or hook delivery.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Stream native Bash ids without retaining command or result text. */
async function transcriptBashEvidence(file: string, toolIds: Set<string>): Promise<{ hasBash: boolean; hookedBash: boolean }> {
  let hasBash = false;
  let hookedBash = false;
  await forEachJsonl(file, row => {
    const message = row['message'];
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const content = (message as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const tool = block as Record<string, unknown>;
      if (tool['type'] !== 'tool_use' || tool['name'] !== 'Bash') continue;
      hasBash = true;
      if (typeof tool['id'] === 'string' && toolIds.has(tool['id'])) hookedBash = true;
    }
  });
  return { hasBash, hookedBash };
}

/** Count only explicit Claude trial sessions confirmed by native transcript and hook evidence. */
export async function readRtkTrialInfo(
  scope: string,
  file: string | null,
  options: { hookDir?: string; projectsDir?: string } = {},
): Promise<RtkTrialInfo | null> {
  if (scope !== 'trial' || !file) return null;
  try {
    const directory = dirname(file);
    const hookDir = options.hookDir ?? join(dirname(directory), 'rtk', 'hook-decisions');
    const projectRoots = await transcriptProjectRoots(dirname(directory), options.projectsDir);
    const nowMs = Date.now();
    const cutoffMs = nowMs - 60 * 86_400_000;
    const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const files = (await readdir(directory)).sort().filter(name => {
      const day = /^cost-attribution-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
      return day !== undefined && day <= today;
    });
    const candidates = new Set<string>();
    for (const name of files) {
      if (name.slice('cost-attribution-'.length, -'.jsonl'.length) < cutoff) continue;
      await forEachJsonl(join(directory, name), row => {
        const id = row['sessionId'];
        const ts = row['ts'];
        if (row['rtkTrialEligible'] === true && row['provider'] === 'claude'
          && typeof id === 'string' && /^[\w-]+$/.test(id)
          && typeof ts === 'number' && Number.isFinite(ts) && ts >= cutoffMs && ts <= nowMs) candidates.add(id);
      });
    }
    if (candidates.size === 0) return null;
    // Retain conflict state only for current candidates; old unrelated
    // sessions must not grow the Savings request's memory with ledger age.
    const sessions = new Map<string, TrialSession>();
    const conflicted = new Set<string>();
    for (const name of files) {
      await forEachJsonl(join(directory, name), row => {
        const sessionId = row['sessionId'];
        if (typeof sessionId !== 'string' || !candidates.has(sessionId) || conflicted.has(sessionId)) return;
        const key = row['rtkTrialKey'];
        const arm = row['rtkArm'];
        const ts = row['ts'];
        const interactive = row['source'] === 'instance-turn' && row['rtkTrialSurface'] === 'interactive'
          && row['instanceId'] === key;
        const loop = row['source'] === 'one-shot' && row['rtkTrialSurface'] === 'loop'
          && typeof row['taskType'] === 'string' && row['taskType'].startsWith('loop-orchestration:')
          && typeof row['correlationId'] === 'string' && typeof key === 'string'
          && row['correlationId'].startsWith(`${key}::`);
        if ((!interactive && !loop) || row['provider'] !== 'claude'
          || row['rtkTrialEligible'] !== true
          || (arm !== 'on' && arm !== 'off')
          || typeof key !== 'string' || !key
          || typeof ts !== 'number' || !Number.isFinite(ts) || ts < cutoffMs || ts > nowMs
        ) {
          // A native transcript spans all turns. One ordinary/provider/
          // mismatched row invalidates the session even between eligible turns.
          sessions.delete(sessionId);
          conflicted.add(sessionId);
          return;
        }
        const previous = sessions.get(sessionId);
        const surface = interactive ? 'interactive' : 'loop';
        if (previous && (previous.arm !== arm || previous.key !== key || previous.surface !== surface)) {
          sessions.delete(sessionId);
          conflicted.add(sessionId);
          return;
        }
        sessions.set(sessionId, { arm, key, surface, firstTimestamp: Math.min(previous?.firstTimestamp ?? ts, ts) });
      });
    }
    if (sessions.size === 0) return null;

    const hooked = new Map<string, Set<string>>();
    const hookSessions = new Set<string>();
    for (const name of await readHookDecisionNames(hookDir)) {
      const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
      if (!day || day < cutoff || day > today) continue;
      await forEachJsonl(join(hookDir, name), row => {
        const sessionId = row['session_id'];
        const ts = Date.parse(typeof row['ts'] === 'string' ? row['ts'] : '');
        if (row['mode'] !== 'rewrite-only' || typeof sessionId !== 'string'
          || !sessions.has(sessionId) || !Number.isFinite(ts) || ts < cutoffMs || ts > nowMs) return;
        hookSessions.add(sessionId);
        if (typeof row['tool_use_id'] === 'string' && row['tool_use_id']) {
          const ids = hooked.get(sessionId) ?? new Set<string>();
          ids.add(row['tool_use_id']);
          hooked.set(sessionId, ids);
        }
      });
    }

    const transcripts = new Map<string, string[]>();
    for (const root of projectRoots) {
      let projects;
      try {
        projects = await readdir(root, { withFileTypes: true });
      } catch (error) {
        // A store that does not exist holds no transcripts; anything else
        // fails safe through the outer catch.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const projectDir = join(root, project.name);
        for (const entry of await readdir(projectDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const sessionId = entry.name.slice(0, -'.jsonl'.length);
          if (!sessions.has(sessionId)) continue;
          transcripts.set(sessionId, [...(transcripts.get(sessionId) ?? []), join(projectDir, entry.name)]);
        }
      }
    }

    let sessionsWithHook = 0;
    let sessionsWithout = 0;
    let firstTimestamp = Infinity;
    for (const [sessionId, session] of sessions) {
      const files = transcripts.get(sessionId);
      if (!files?.length || (session.arm === 'off' && hookSessions.has(sessionId))) continue;
      const ids = hooked.get(sessionId) ?? new Set<string>();
      const evidence = await Promise.all(files.map(path => transcriptBashEvidence(path, ids)));
      if (!evidence.some(item => item.hasBash)) continue;
      if (session.arm === 'on') {
        if (!evidence.some(item => item.hookedBash)) continue;
        sessionsWithHook += 1;
      } else {
        sessionsWithout += 1;
      }
      firstTimestamp = Math.min(firstTimestamp, session.firstTimestamp);
    }
    return sessionsWithHook + sessionsWithout === 0 ? null : {
      startedAt: new Date(firstTimestamp).toISOString().slice(0, 10),
      sessionsWithHook,
      sessionsWithout,
    };
  } catch (error) {
    // Fail safe (no trial block) on any unexpected read error, but say so once per process.
    if (!loggedReadFailure) {
      loggedReadFailure = true;
      logger.warn('RTK trial status could not be read; reporting no trial', {
        code: (error as NodeJS.ErrnoException).code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}
