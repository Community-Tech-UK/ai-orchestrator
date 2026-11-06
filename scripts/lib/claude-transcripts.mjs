/**
 * claude-transcripts.mjs — the one Claude transcript reader.
 *
 * Shared by `context-ceiling-replay.mjs` (A4 replay), the `--subagents`
 * section of `claude-cost-audit-report.mjs` (A18) and `rtk-trial-report.mjs`
 * (A13). Read-only: it parses Claude Code JSONL transcripts and never writes.
 *
 * Method (from the October transcript audit):
 *   - assistant entries are de-duplicated by `message.id` (streamed replies
 *     repeat it) and `<synthetic>` entries (model '<synthetic>', injected by
 *     compaction) are dropped;
 *   - each request is read from `message.usage`: `input_tokens` (uncached),
 *     `cache_read_input_tokens`, `cache_creation_input_tokens` with its
 *     5-minute/1-hour split, `output_tokens`, plus the entry timestamp and the
 *     model;
 *   - `compact_boundary` system entries carry `compactMetadata` (pre/post
 *     tokens), so the real post-summary context size can be measured;
 *   - a "return" is a gap of at least RETURN_GAP_MS between consecutive
 *     requests in one transcript; a gap of at least COLD_GAP_MS is a cold
 *     return (the cache has expired and the context is re-written);
 *   - a "restart" is the first request after a `cost-state` record (Claude
 *     writes one when a process ends), so a resumed session shows up as a
 *     restart whatever the gap. Whether the ended process edited files comes
 *     from its `Edit`/`Write`/`MultiEdit`/`NotebookEdit` tool_use blocks, a
 *     `git commit` Bash command, or growth in the cost-state's
 *     `totalLinesAdded`/`totalLinesRemoved`. Only the tool name and a
 *     commit-shaped command are inspected, never retained.
 */

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RETURN_GAP_MS = 5 * 60 * 1000;
export const COLD_GAP_MS = 55 * 60 * 1000;
/** A restart keeps the cache when its first request reads this share of the prior context. */
export const RESUME_KEPT_SHARE = 0.9;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_SEGMENT = /[^\n;&|]+/g;
const GIT_WORD = /\bgit\b/;
const COMMIT_WORD = /\bcommit\b/g;

/**
 * List-price multipliers relative to the input token price: cache reads at
 * 0.1x, cache writes at 1.25x (5-minute) or 2x (1-hour). Output is priced per
 * model from the one shared price table; unknown models fall back to
 * Sonnet-class numbers and are reported as a caveat. Override with
 * `--prices <json>`.
 */
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2;

/**
 * The one Claude price table (USD per million tokens): Phase 0 step 7b's
 * `--compare-transcripts` rates, kept here so that comparison, the A4 replay
 * and the A18 helper report price models identically (Step 3's code sharing).
 * Family rates cover bare family names and unlisted generations; the model
 * rules below carry the per-id rates.
 */
export const CLAUDE_PRICES = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  fable: { input: 10, output: 50 },
};

/**
 * Per-id rates, in Phase 0's resolution order (most specific generation first).
 * The 5.5-generation and legacy dated-Opus-4 rows come from `MODEL_PRICING`
 * (`src/shared/types/provider.types.ts`) where the family fallback would price
 * them differently. Bare family names never match these rows and keep the
 * family rates above.
 */
const MODEL_RATES = [
  ['sonnet-5', { input: 2, output: 10 }],
  ['claude-3-opus', { input: 15, output: 75 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4 }],
  ['claude-3-haiku', { input: 0.25, output: 1.25 }],
  ['claude-3-sonnet', { input: 3, output: 15 }],
  ['claude-opus-5-5', { input: 4, output: 20 }],
  ['claude-haiku-5-5', { input: 0.1, output: 0.5 }],
  ['claude-opus-4-2025', { input: 15, output: 75 }],
];

/**
 * Phase 0's per-model rate resolution: `{ input, output }` per million tokens,
 * or undefined when the model is unpriced (the comparison reports it; the
 * replay/report callers fall back to Sonnet-class numbers with a caveat).
 */
export function rateForModel(model) {
  const name = String(model ?? '').toLowerCase();
  for (const [needle, rate] of MODEL_RATES) {
    if (name.includes(needle)) return { ...rate };
  }
  const family = Object.keys(CLAUDE_PRICES).find((key) => name.includes(key));
  return family ? { ...CLAUDE_PRICES[family] } : undefined;
}

/**
 * Price of one recorded request's model: `{ inputPerMTok, outputPerMTok,
 * known }`. `overrides` maps lowercased model names to explicit
 * `{ inputPerMTok, outputPerMTok }` rates (`--prices <json>`).
 */
export function priceFor(model, overrides) {
  const name = String(model ?? '').toLowerCase();
  if (overrides && name && overrides[name]) return { ...overrides[name], known: true };
  const rate = rateForModel(model);
  if (rate) return { inputPerMTok: rate.input, outputPerMTok: rate.output, known: true };
  return { inputPerMTok: CLAUDE_PRICES.sonnet.input, outputPerMTok: CLAUDE_PRICES.sonnet.output, known: false };
}

// ── Small statistics helpers ────────────────────────────────────────────────

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function p90(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
}

export function mean(values) {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

// ── Transcript discovery ────────────────────────────────────────────────────

/**
 * Every main (`<projects>/<munged>/<session>.jsonl`) and subagent
 * (`<projects>/<munged>/<session>/subagents/agent-*.jsonl`) transcript under
 * `projectsDir`.
 */
export function listTranscripts(projectsDir) {
  const out = [];
  if (!projectsDir || !existsSync(projectsDir)) return out;
  const projectDirs = readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const project of projectDirs) {
    const projectDir = join(projectsDir, project.name);
    let entries;
    try {
      entries = readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(projectDir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push({ path: full, kind: 'main', sessionId: entry.name.replace(/\.jsonl$/, '') });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const subagentsDir = join(full, 'subagents');
      if (!existsSync(subagentsDir)) continue;
      let subs;
      try {
        subs = readdirSync(subagentsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (sub.isFile() && sub.name.endsWith('.jsonl')) {
          out.push({ path: join(subagentsDir, sub.name), kind: 'subagent', sessionId: entry.name });
        }
      }
    }
  }
  return out;
}

// ── Transcript parsing ──────────────────────────────────────────────────────

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Parse one transcript into the shapes the replay and reports need. No
 * message text is read beyond the class markers.
 *
 * Returns:
 *   requests: [{ at, input, cacheRead, cacheWrite5m, cacheWrite1h, output, model, context }]
 *   compactions: [{ at, preTokens, postTokens }]
 *   restarts: [{ at, gapMs, edited, priorContext, firstCacheRead, compactedInGap }]
 *     (`edited` is true / false / null when the transcript cannot say)
 *   entrypoint, isSyntheticSeen
 */
export async function parseTranscript(path) {
  const requests = [];
  let unknownUsageRecords = 0;
  const compactions = [];
  const restarts = [];
  const seenMessageIds = new Set();
  // Process-end tracking for restarts. `lastRequest` is the latest accepted
  // request in file order; `toolEdit` is edit evidence since the last process
  // end; `pendingEnd` waits for the first request of the next process.
  let lastRequest = null;
  let toolEdit = false;
  let pendingEnd = null;
  let lastLinesTotal = 0;
  let compactedSinceLastRequest = false;
  let entrypoint = null;
  let sawSdkCli = false;
  let sawToolPermissionsMarker = false;

  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      unknownUsageRecords += 1;
      continue;
    }
    if (!asRecord(entry)) { unknownUsageRecords += 1; continue; }
    const type = entry['type'];
    if (type === 'system' && entry['subtype'] === 'compact_boundary') {
      const meta = asRecord(entry['compactMetadata']) ?? asRecord(entry['compact_metadata']);
      compactions.push({
        at: Date.parse(entry['timestamp'] ?? '') || null,
        preTokens: meta?.['preTokens'] ?? meta?.['pre_tokens'] ?? null,
        postTokens: meta?.['postTokens'] ?? meta?.['post_tokens'] ?? null,
      });
      compactedSinceLastRequest = true;
      continue;
    }
    if (type === 'cost-state') {
      const added = entry['totalLinesAdded'];
      const removed = entry['totalLinesRemoved'];
      const hasLines = typeof added === 'number' && typeof removed === 'number';
      const linesEdit = hasLines ? added + removed > lastLinesTotal : null;
      if (hasLines) lastLinesTotal = added + removed;
      // Two process-end records with no request between are one end.
      pendingEnd = {
        prev: pendingEnd ? pendingEnd.prev : lastRequest,
        toolEdit: (pendingEnd?.toolEdit ?? false) || toolEdit,
        linesEdit: pendingEnd ? mergeEvidence(pendingEnd.linesEdit, linesEdit) : linesEdit,
        compacted: (pendingEnd?.compacted ?? false) || compactedSinceLastRequest,
      };
      toolEdit = false;
      continue;
    }
    // The [Tool Permissions] marker lives in the prompt snapshot; scan both
    // user and assistant entries for it (the transcript audit's method).
    if (!sawToolPermissionsMarker && line.includes('[Tool Permissions]')) {
      sawToolPermissionsMarker = true;
    }
    if (type !== 'assistant') continue;
    const message = asRecord(entry['message']);
    if (!message) continue;
    if (message['model'] === '<synthetic>') continue;
    // Streamed replies repeat `message.id` with different content blocks, so
    // look for edits before the de-duplication below.
    if (!toolEdit && Array.isArray(message['content'])) toolEdit = hasEditToolUse(message['content']);
    const messageId = message['id'];
    if (typeof messageId === 'string' && messageId) {
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }
    if (typeof entry['entrypoint'] === 'string') {
      entrypoint = entry['entrypoint'];
      if (entry['entrypoint'] === 'sdk-cli') sawSdkCli = true;
    }
    const usage = asRecord(message['usage']);
    if (!usage) {
      if (message.usage !== undefined && message.usage !== null) unknownUsageRecords += 1;
      continue;
    }
    const creation = asRecord(usage['cache_creation']) ?? {};
    if (usage.cache_creation !== undefined && usage.cache_creation !== null && !asRecord(usage.cache_creation)) {
      unknownUsageRecords += 1;
    }
    // Raw CLI counters may be absent; the SDK also allows null cache totals.
    // Preserve those zero semantics, but supplied invalid numbers lose evidence.
    const counters = [usage.input_tokens, usage.output_tokens,
      ...[usage.cache_read_input_tokens, usage.cache_creation_input_tokens].filter(value => value !== null),
      creation.ephemeral_5m_input_tokens, creation.ephemeral_1h_input_tokens];
    if (counters.some(value => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {
      unknownUsageRecords += 1;
    }
    const input = num(usage['input_tokens']);
    const cacheRead = num(usage['cache_read_input_tokens']);
    const cacheWrite5m = num(creation['ephemeral_5m_input_tokens']);
    const cacheWrite1h = num(creation['ephemeral_1h_input_tokens']);
    const cacheWriteTotal = num(usage['cache_creation_input_tokens']);
    // When the split is missing, treat the whole write as 5-minute.
    const write5m = cacheWrite5m || Math.max(0, cacheWriteTotal - cacheWrite1h);
    const write1h = cacheWrite1h;
    const output = num(usage['output_tokens']);
    const at = Date.parse(entry['timestamp'] ?? '') || null;
    if (at === null) unknownUsageRecords += 1;
    const request = {
      at,
      input,
      cacheRead,
      cacheWrite5m: write5m,
      cacheWrite1h: write1h,
      output,
      model: message['model'] ?? null,
      context: input + cacheRead + write5m + write1h,
    };
    requests.push(request);
    if (pendingEnd?.prev) {
      restarts.push({
        at,
        gapMs: at !== null && pendingEnd.prev.at !== null ? at - pendingEnd.prev.at : null,
        // An edit tool_use or a commit is positive evidence; otherwise only an
        // explicit zero change in the cost-state's line totals says "no edits".
        edited: pendingEnd.toolEdit || pendingEnd.linesEdit === true ? true : pendingEnd.linesEdit === false ? false : null,
        priorContext: pendingEnd.prev.context,
        firstCacheRead: cacheRead,
        compactedInGap: pendingEnd.compacted,
      });
    }
    pendingEnd = null;
    lastRequest = request;
    compactedSinceLastRequest = false;
  }

  return {
    unknownUsageRecords,
    requests: requests.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    restarts,
    compactions,
    entrypoint,
    isHarness: sawSdkCli && sawToolPermissionsMarker,
  };
}

/**
 * True for the same commands the old `/\bgit\b[^\n;&|]*\bcommit\b/` matched, in linear time. That
 * pattern retried the commit scan from every `git` word and took 30s at 200 KB of `git ` with no
 * `commit`. Its `[^\n;&|]*` cannot cross a separator, so each separator-free segment is checked
 * alone: the first `git` word in it leaves the longest tail, so a `commit` word in the tail after
 * that word is the same as the pattern finding one after any `git` word. Segment ends are
 * non-word characters (or the string ends), which is how `\b` already read them.
 */
export function isGitCommitCommand(command) {
  for (const [segment] of command.matchAll(COMMAND_SEGMENT)) {
    const git = GIT_WORD.exec(segment);
    if (!git) continue;
    COMMIT_WORD.lastIndex = git.index + git[0].length;
    if (COMMIT_WORD.test(segment)) return true;
  }
  return false;
}

function hasEditToolUse(blocks) {
  for (const block of blocks) {
    const rec = asRecord(block);
    if (!rec || rec['type'] !== 'tool_use') continue;
    if (EDIT_TOOLS.has(rec['name'])) return true;
    const command = rec['name'] === 'Bash' ? asRecord(rec['input'])?.['command'] : null;
    if (typeof command === 'string' && isGitCommitCommand(command)) return true;
  }
  return false;
}

// true beats false beats null: two process ends with no request between them.
function mergeEvidence(a, b) {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return null;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The first request after each real `compact_boundary`: its total context is
 * the measured post-summary size (the sawtooth's floor F).
 */
export function measuredSummaryFloors(parsed) {
  const floors = [];
  for (const compaction of parsed.compactions) {
    const at = compaction.at;
    if (at === null) continue;
    const next = parsed.requests.find((r) => r.at !== null && r.at > at);
    if (next) floors.push(next.context);
  }
  return floors;
}

/**
 * Activity returns: gaps of at least RETURN_GAP_MS between consecutive
 * requests. `cold` marks gaps of at least COLD_GAP_MS (cache expired).
 * `rewrittenTokens` is the whole cache write; `rewrittenTokens5m`/
 * `rewrittenTokens1h` keep its 5-minute/1-hour split so callers can price each
 * part at its own multiple (CACHE_WRITE_5M_MULT / CACHE_WRITE_1H_MULT).
 */
export function activityReturns(parsed) {
  const returns = [];
  for (let i = 1; i < parsed.requests.length; i++) {
    const prev = parsed.requests[i - 1];
    const next = parsed.requests[i];
    if (prev.at === null || next.at === null) continue;
    const gapMs = next.at - prev.at;
    if (gapMs < RETURN_GAP_MS) continue;
    returns.push({
      at: next.at,
      gapMs,
      cold: gapMs >= COLD_GAP_MS,
      keptCacheShare: prev.context > 0 ? next.cacheRead / prev.context : 0,
      rewrittenTokens: next.cacheWrite5m + next.cacheWrite1h,
      rewrittenTokens5m: next.cacheWrite5m,
      rewrittenTokens1h: next.cacheWrite1h,
    });
  }
  return returns;
}

/**
 * Restarts for the `--resume-cache` guard: the first request after a process
 * ended, judged against the last request before it. Each carries:
 *   category: 'cold' (idle at least COLD_GAP_MS: the cache expired, no switch
 *     fixes that), 'no-edits' (restart within the window after a process that
 *     edited nothing), 'unknown' (the transcript cannot establish the gap, the
 *     edit state or the prior context, or a compaction changed the context),
 *     or 'edited' (the guard's population);
 *   kept: for 'edited' only, whether the first request read at least
 *     RESUME_KEPT_SHARE of the prior context from cache.
 * An element the transcript cannot establish is 'unknown', never assumed.
 */
export function resumeRestarts(parsed) {
  const out = [];
  for (const restart of parsed.restarts ?? []) {
    const keptCacheShare = restart.priorContext > 0 ? restart.firstCacheRead / restart.priorContext : null;
    let category = 'edited';
    let unknownReason = null;
    if (restart.gapMs === null || restart.gapMs < 0) {
      category = 'unknown';
      unknownReason = 'gap';
    } else if (restart.gapMs >= COLD_GAP_MS) {
      category = 'cold';
    } else if (restart.edited === false) {
      category = 'no-edits';
    } else if (restart.edited === null) {
      category = 'unknown';
      unknownReason = 'edits';
    } else if (keptCacheShare === null) {
      category = 'unknown';
      unknownReason = 'context';
    } else if (restart.compactedInGap) {
      category = 'unknown';
      unknownReason = 'compaction';
    }
    out.push({
      at: restart.at,
      gapMs: restart.gapMs,
      category,
      unknownReason,
      keptCacheShare,
      kept: category === 'edited' ? keptCacheShare >= RESUME_KEPT_SHARE : null,
    });
  }
  return out;
}

/** Default projects root (`~/.claude/projects`, or $CLAUDE_CONFIG_DIR/projects). */
export function defaultProjectsDir() {
  const configDir = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
  return join(configDir, 'projects');
}

/**
 * Every Claude transcript root to scan: the default projects directory plus
 * `<userData>/claude-cli-profiles/<profile>/projects` for each Harness-managed
 * account profile (the account adapter routes derived profiles into these
 * homes). Directories only; no auth/config/credential files are read. An
 * explicit override replaces discovery entirely.
 */
export function transcriptProjectsDirs(userData, explicit = null) {
  if (explicit) return [explicit];
  const dirs = [defaultProjectsDir()];
  const profiles = join(userData, 'claude-cli-profiles');
  if (existsSync(profiles)) {
    for (const profile of readdirSync(profiles, { withFileTypes: true })) {
      const projects = join(profiles, profile.name, 'projects');
      if (profile.isDirectory() && existsSync(projects) && statSync(projects).isDirectory()) dirs.push(projects);
    }
  }
  return [...new Set(dirs)];
}

/** True for files newer than `sinceMs` (0 = no filter). */
export function isRecent(path, sinceMs) {
  if (!sinceMs) return true;
  try {
    return statSync(path).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

/**
 * The `.meta.json` beside a subagent transcript (`agent-<id>.jsonl` +
 * `agent-<id>.meta.json`): `{ agentType, description, toolUseId, spawnDepth,
 * requestShape, requestNonInteractive }`. Returns null when missing or
 * malformed. No message text is read here either.
 */
export function readSubagentMeta(path) {
  const metaPath = path.replace(/\.jsonl$/, '.meta.json');
  if (metaPath === path || !existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
    return asRecord(parsed);
  } catch {
    return null;
  }
}

/**
 * Task-tool outcomes in a parent transcript: `tool_use` blocks named `Task`
 * register their id; later `tool_result` blocks carry `tool_use_id` and
 * `is_error`. Only structural fields are read — no tool input or output text.
 * Retains the user turn, spawn and actual tool-result return timestamps too.
 */
export function parseTaskToolOutcomes(path) {
  const outcomes = new Map();
  let parentTurnId = null;
  let turnSequence = 0;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = asRecord(entry['message']);
    const content = message ? message['content'] : null;
    const userInput = entry.type === 'user' && entry.isMeta !== true && entry.isCompactSummary !== true
      && (typeof content === 'string' || (Array.isArray(content)
        && content.some(block => block?.type === 'text') && !content.some(block => block?.type === 'tool_result')));
    if (userInput) parentTurnId = entry.uuid ?? `user-turn-${++turnSequence}`;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const rec = asRecord(block);
      if (!rec) continue;
      if (rec['type'] === 'tool_use' && (rec['name'] === 'Task' || rec['name'] === 'Agent') && typeof rec['id'] === 'string') {
        if (!outcomes.has(rec['id'])) outcomes.set(rec['id'], {
          isError: false, parentTurnId, startedAt: Date.parse(entry.timestamp ?? '') || null, returnedAt: null,
        });
      } else if (rec['type'] === 'tool_result' && typeof rec['tool_use_id'] === 'string') {
        const prev = outcomes.get(rec['tool_use_id']);
        outcomes.set(rec['tool_use_id'], { ...prev,
          isError: prev ? prev.isError || rec['is_error'] === true : rec['is_error'] === true,
          returnedAt: Date.parse(entry.timestamp ?? '') || null,
        });
      }
    }
  }
  return outcomes;
}

/** Model family of a model string ('opus' | 'sonnet' | 'haiku' | 'other'). */
export function modelFamily(model) {
  const name = String(model ?? '').toLowerCase();
  for (const family of ['opus', 'sonnet', 'haiku']) {
    if (name.includes(family)) return family;
  }
  return 'other';
}
