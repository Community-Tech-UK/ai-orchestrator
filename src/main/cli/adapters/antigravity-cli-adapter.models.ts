/**
 * Antigravity CLI (`agy`) — model catalog discovery.
 *
 * Mirrors `grok-cli-adapter.models.ts`: pure parser + classifier functions plus
 * a spawn-injected discovery helper, with no dependency on the adapter class.
 *
 * `agy models` (verified on 1.4.11) prints a progress line, then one
 * tab-separated `<id>\t<label>` row per model, and exits 0:
 *
 *     Fetching available models...
 *     gemini-4-argon-medium	Gemini 4 Argon (Medium)
 *     gemini-3.8-flash-low	Gemini 3.8 Flash (Low)
 *     gpt-oss-120b-medium	GPT-OSS 120B (Medium)
 *
 * `--model` accepts either column. AIO keys antigravity models by the LABEL —
 * that is what persisted settings, sessions and automations already hold — so
 * the label becomes the model id and the short id is discarded.
 */

import type { ChildProcess } from 'child_process';
import { stripVTControlCharacters } from 'util';
import {
  MAX_MODEL_ID_LENGTH,
  type ModelDisplayInfo,
} from '../../../shared/types/provider.types';
import { killProcessGroup } from './base-cli-process-utils';

/** How often the live `agy models` list is re-read into the catalog. */
export const ANTIGRAVITY_MODEL_DISCOVERY_INTERVAL_MS = 30 * 60_000;

/** Hard cap on a single `agy models` run before it is killed. */
const ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

/** `<short-id>\t<label>`. The short id is a single lowercase slug. */
const ANTIGRAVITY_MODEL_ROW = /^([a-z0-9][a-z0-9.-]*)\t(\S.*)$/;

/**
 * Coarse tier for display / `resolveModelForTier`. The effort suffix does not
 * change a model's class, except that a Flash model at Low effort is the
 * provider's fast option.
 */
export function classifyAntigravityModelTier(label: string): 'fast' | 'balanced' | 'powerful' {
  if (/^Gemini\b.*\bFlash\b/i.test(label)) {
    return /\(Low\)$/i.test(label) ? 'fast' : 'balanced';
  }
  if (/^Gemini\b/i.test(label) || /^Claude Opus\b/i.test(label)) {
    return 'powerful';
  }
  return 'balanced';
}

/** Picker grouping. Any non-Flash Gemini is the flagship line, whatever its codename. */
export function classifyAntigravityModelFamily(label: string): string | undefined {
  if (/^Gemini\b.*\bFlash\b/i.test(label)) return 'Gemini Flash';
  if (/^Gemini\b/i.test(label)) return 'Gemini Pro';
  if (/^Claude\b/i.test(label)) return 'Claude';
  if (/^GPT\b/i.test(label)) return 'GPT';
  return undefined;
}

/** Parse `agy models` output into labels, in the CLI's order. Unknown lines are ignored. */
export function parseAntigravityModelList(output: string): string[] {
  const labels = new Set<string>();
  for (const rawLine of stripVTControlCharacters(output).split(/\r?\n/)) {
    const match = rawLine.trim().match(ANTIGRAVITY_MODEL_ROW);
    if (!match) continue;
    const label = match[2].trim();
    if (label.length > MAX_MODEL_ID_LENGTH) continue;
    labels.add(label);
  }
  return [...labels];
}

/**
 * Convert parsed labels into picker rows. agy marks no default, so each
 * model's `(Medium)` effort is pinned: one entry per model line in the
 * picker's "Latest" section, and the first pinned row (agy lists its own
 * default first) becomes the provider primary.
 */
export function toAntigravityModelDisplayInfos(labels: string[]): ModelDisplayInfo[] {
  return labels.map((label) => {
    const family = classifyAntigravityModelFamily(label);
    return {
      id: label,
      name: label,
      tier: classifyAntigravityModelTier(label),
      ...(/\(Medium\)$/i.test(label) ? { pinned: true } : {}),
      ...(family ? { family } : {}),
    };
  });
}

/**
 * Run `agy models` (via the injected `spawn` thunk) and parse it. REJECTS on
 * failure so the caller decides how to degrade — the discovery service logs
 * and keeps whatever the catalog already had.
 */
export function discoverAntigravityModels(spawn: () => ChildProcess): Promise<ModelDisplayInfo[]> {
  return new Promise<ModelDisplayInfo[]>((resolve, reject) => {
    const proc = spawn();
    let output = '';
    let errorOutput = '';

    proc.stdout?.on('data', (data) => {
      output += (data as Buffer).toString();
    });
    proc.stderr?.on('data', (data) => {
      errorOutput += (data as Buffer).toString();
    });

    const timer = setTimeout(() => {
      if (!killProcessGroup(proc.pid, 'SIGTERM')) {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignored */
        }
      }
      reject(new Error('Timeout fetching Antigravity model list'));
    }, ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // A signed-out or failing CLI prints no model rows; never publish a
      // partial list from a run that did not succeed. agy prints its progress
      // line on stderr and the rows on stdout; both streams are parsed, as for
      // Grok, so a release that moves the rows still parses (rows dedupe).
      const labels = code === 0 ? parseAntigravityModelList(`${output}\n${errorOutput}`) : [];
      if (labels.length > 0) {
        resolve(toAntigravityModelDisplayInfos(labels));
        return;
      }
      reject(
        new Error(
          `Failed to read Antigravity model list (exit ${code}): ${errorOutput.trim() || output.trim() || 'no output'}`,
        ),
      );
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
