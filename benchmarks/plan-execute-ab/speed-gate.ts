import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type {
  LocalArmEndpoint,
  LocalSpeedSample,
  SpeedGateDecision,
  SpeedGateLog,
  SpeedGateRecord,
  SpeedGateSample,
} from './types';

export const PROMPT_SPEED_GATE_TOK_PER_S = 300;
export const WRITE_SPEED_GATE_TOK_PER_S = 15;
/**
 * The C2 gate measures the plan's real workload: "a real 30k-token agent
 * prompt" (plan: speed gate). A smaller measured prompt proves nothing about
 * that workload, so the gate withholds its verdict until one is measured.
 */
export const REAL_PROMPT_MIN_TOKENS = 30_000;

export interface SpeedProbeOptions {
  endpoint: LocalArmEndpoint;
  apiKey: string;
  /** Defaults to a synthesised ~30k-token agent-style prompt. */
  promptText?: string;
  targetPromptTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable clock so wall-clock derivations are testable. */
  now?: () => number;
  /** Random source used to make each probe prompt unique (defeats prompt caching). */
  nonce?: () => string;
}

const FILLER_LINE =
  'export function reconcileLedger(entries: LedgerEntry[], cutoff: number): ReconcileResult {\n' +
  '  const kept = entries.filter((entry) => entry.timestamp >= cutoff);\n' +
  '  const dropped = entries.length - kept.length;\n' +
  '  return { kept, dropped, checksum: kept.reduce((sum, entry) => sum + entry.amount, 0) };\n' +
  '}\n';

export function buildProbePrompt(targetPromptTokens: number): string {
  const header = [
    'You are an implementation agent in a large TypeScript monorepo. The task below is representative of real work.',
    'Read the context, then answer with a short implementation outline (no code changes; this is a speed measurement).',
    '',
    'Task: fix a race where a queued disconnect save is dropped during shutdown, and add regression coverage.',
    '',
    'Context excerpts follow.',
    '',
  ].join('\n');
  const approxCharsPerToken = 4;
  const targetChars = targetPromptTokens * approxCharsPerToken;
  let body = '';
  while (header.length + body.length < targetChars) {
    body += FILLER_LINE;
  }
  return header + body;
}

interface TimingInfo {
  promptTokensPerSec: number | null;
  writeTokensPerSec: number | null;
  promptTokens: number;
  writeTokens: number;
}

function extractTiming(jsonText: string): TimingInfo {
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  const usage = (parsed['usage'] ?? {}) as Record<string, unknown>;
  const timings = (parsed['timings'] ?? {}) as Record<string, unknown>;
  const num = (obj: Record<string, unknown>, key: string): number => {
    const value = obj[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  const promptTokens = num(usage, 'prompt_tokens') || num(timings, 'prompt_n') || num(usage, 'input_tokens');
  const writeTokens = num(usage, 'completion_tokens') || num(timings, 'predicted_n') || num(usage, 'output_tokens');
  const promptPerSec = num(timings, 'prompt_per_second');
  const writePerSec = num(timings, 'predicted_per_second');
  return {
    promptTokensPerSec: promptPerSec > 0 ? promptPerSec : null,
    writeTokensPerSec: writePerSec > 0 ? writePerSec : null,
    promptTokens,
    writeTokens,
  };
}

interface ProbeResult {
  timing: TimingInfo;
  durationMs: number;
}

/**
 * One request against the endpoint in the same message format Claude Code uses
 * (`/v1/messages` for anthropic-style endpoints), with a prompt whose first
 * lines carry a unique nonce so two probes never share a prompt cache prefix.
 */
async function probeRequest(
  options: SpeedProbeOptions,
  prompt: string,
  maxTokens: number,
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.endpoint.apiStyle === 'anthropic'
    ? `${options.endpoint.baseUrl.replace(/\/$/, '')}/v1/messages`
    : `${options.endpoint.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const body = {
    model: options.endpoint.servedModelName,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.endpoint.apiStyle === 'anthropic') {
    headers['x-api-key'] = options.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['authorization'] = `Bearer ${options.apiKey}`;
  }

  const startedAt = (options.now ?? Date.now)();
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
  });
  const jsonText = await response.text();
  const durationMs = Math.max((options.now ?? Date.now)() - startedAt, 1);
  if (!response.ok) {
    throw new Error(`speed probe failed: HTTP ${response.status}: ${jsonText.slice(0, 300)}`);
  }

  let timing: TimingInfo;
  try {
    timing = extractTiming(jsonText);
  } catch {
    throw new Error(`speed probe: could not parse server response: ${jsonText.slice(0, 300)}`);
  }
  return { timing, durationMs };
}

/**
 * Two probes, both on real ~30k-token agent-style prompts:
 *
 * 1. prompt probe — 30k prompt, 1 output token: wall time is prompt processing.
 * 2. write probe — a *different* 30k prompt (unique nonce in the header, so no
 *    cache prefix is shared), 256 output tokens: wall time minus the prompt
 *    probe's time is the write phase, which keeps the "write speed falls as
 *    context fills" behaviour in the measurement.
 *
 * Server-reported timings (llama.cpp `timings`) win when present; LM Studio's
 * Anthropic endpoint reports none, so the wall-clock derivation is the normal
 * path for local arms.
 */
export async function measureSpeed(options: SpeedProbeOptions): Promise<SpeedGateSample> {
  const nonce = options.nonce ?? (() => Math.random().toString(36).slice(2, 10));
  const base = options.promptText ?? buildProbePrompt(options.targetPromptTokens ?? 30_000);
  const promptA = `probe nonce ${nonce()}\n${base}`;
  const promptB = `probe nonce ${nonce()}\n${base}`;

  const probeA = await probeRequest(options, promptA, 1);
  const probeB = await probeRequest(options, promptB, 256);

  const serverTimings = probeB.timing.promptTokensPerSec !== null || probeB.timing.writeTokensPerSec !== null;

  let promptTokensPerSec: number;
  let writeTokensPerSec: number;
  let measuredPromptSpeed: boolean;
  let source: 'server-timings' | 'wall-clock' | 'unmeasured';

  if (serverTimings) {
    promptTokensPerSec = probeB.timing.promptTokensPerSec
      ?? (probeB.timing.promptTokens / (probeB.durationMs / 1000));
    writeTokensPerSec = probeB.timing.writeTokensPerSec
      ?? (probeB.timing.writeTokens > 0 ? (probeB.timing.writeTokens / (probeB.durationMs / 1000)) : 0);
    measuredPromptSpeed = probeB.timing.promptTokensPerSec !== null;
    source = 'server-timings';
  } else {
    promptTokensPerSec = probeA.timing.promptTokens > 0
      ? probeA.timing.promptTokens / (probeA.durationMs / 1000)
      : 0;
    measuredPromptSpeed = promptTokensPerSec > 0;
    const writePhaseMs = probeB.durationMs - probeA.durationMs;
    writeTokensPerSec = probeB.timing.writeTokens > 0 && writePhaseMs > 100
      ? probeB.timing.writeTokens / (writePhaseMs / 1000)
      : 0;
    source = measuredPromptSpeed || writeTokensPerSec > 0 ? 'wall-clock' : 'unmeasured';
  }

  return {
    promptTokensPerSec,
    writeTokensPerSec,
    promptTokens: Math.max(probeA.timing.promptTokens, probeB.timing.promptTokens),
    writeTokens: probeB.timing.writeTokens,
    durationMs: probeA.durationMs + probeB.durationMs,
    measuredPromptSpeed,
    source,
  };
}

/**
 * The C2 keep/drop verdict for a real-prompt measurement. Returns null
 * (decision WITHHELD, nothing banked) when the measured prompt is smaller
 * than the protocol's real 30k-token workload: a short prompt cannot prove
 * the 300/15 tok/s floors at the size the gate is written for, and must not
 * be accepted as one. Re-run with a real 30k-token prompt to decide.
 */
export function applySpeedGate(sample: SpeedGateSample): SpeedGateDecision | null {
  if (sample.promptTokens < REAL_PROMPT_MIN_TOKENS) return null;
  const reasons: string[] = [];
  let keepC2 = true;
  if (!sample.measuredPromptSpeed) {
    keepC2 = false;
    reasons.push('prompt speed unmeasured: the server did not report prompt timings, so the 300 tok/s floor cannot be shown');
  } else if (sample.promptTokensPerSec < PROMPT_SPEED_GATE_TOK_PER_S) {
    keepC2 = false;
    reasons.push(
      `prompt speed ${sample.promptTokensPerSec.toFixed(1)} tok/s is below the ${PROMPT_SPEED_GATE_TOK_PER_S} tok/s gate`,
    );
  }
  if (sample.writeTokensPerSec === 0) {
    keepC2 = false;
    reasons.push('write speed unmeasured');
  } else if (sample.writeTokensPerSec < WRITE_SPEED_GATE_TOK_PER_S) {
    keepC2 = false;
    reasons.push(
      `write speed ${sample.writeTokensPerSec.toFixed(1)} tok/s is below the ${WRITE_SPEED_GATE_TOK_PER_S} tok/s gate`,
    );
  }
  if (keepC2) {
    reasons.push(
      `prompt ${sample.promptTokensPerSec.toFixed(0)} tok/s and write ${sample.writeTokensPerSec.toFixed(1)} tok/s both clear the gate`,
    );
  }
  return { keepC2, sample, reasons };
}

export function speedGateLogPath(resultsRoot: string): string {
  return join(resultsRoot, 'speed-gate.json');
}

/** Missing file means nothing measured yet; a corrupt file throws loudly. */
export function loadSpeedGateLog(path: string): SpeedGateLog {
  if (!existsSync(path)) return { version: 1, entries: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SpeedGateLog>;
  return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
}

/** Append a measurement; history is kept so contaminated readings stay visible. */
export function appendSpeedGateRecord(path: string, record: SpeedGateRecord): SpeedGateLog {
  const log = loadSpeedGateLog(path);
  log.entries.push(record);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(log, null, 2));
  return log;
}

/** The gate decision session reports use: the newest Flash-Next measurement. */
export function speedGateDecisionFromEntries(entries: SpeedGateRecord[]): SpeedGateDecision | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.modelKey === 'qwen3.8-flash-next' && entry.decision) return entry.decision;
  }
  return null;
}

/** Newest measurement per model, for report rendering. */
export function latestSpeedGateByModel(entries: SpeedGateRecord[]): SpeedGateRecord[] {
  const latest = new Map<string, SpeedGateRecord>();
  for (const entry of entries) latest.set(entry.modelKey, entry);
  return [...latest.values()];
}

/**
 * Per-run probe for a local arm's run record. Never throws: a failed probe is
 * recorded as `unmeasured` with the reason, so a run is never held up or
 * failed by the measurement step.
 */
export async function probeLocalSpeed(
  endpoint: LocalArmEndpoint,
  apiKey: string,
  probe?: Partial<SpeedProbeOptions>,
): Promise<LocalSpeedSample> {
  try {
    const sample = await measureSpeed({ endpoint, apiKey, timeoutMs: 300_000, ...probe });
    return {
      promptTokensPerSec: sample.promptTokensPerSec > 0 ? sample.promptTokensPerSec : null,
      writeTokensPerSec: sample.writeTokensPerSec > 0 ? sample.writeTokensPerSec : null,
      source: sample.source ?? 'unmeasured',
    };
  } catch (error) {
    return {
      promptTokensPerSec: null,
      writeTokensPerSec: null,
      source: 'unmeasured',
      note: `run probe failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
    };
  }
}
