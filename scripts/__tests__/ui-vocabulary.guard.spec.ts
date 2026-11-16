import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { scanUiText, type ScanResult } from '../ui-text/extract-ui-text';
import { appNameHits, countByFile, instanceThreadHits, statusWordHits, type UiTextHit } from '../ui-text/ui-text-rules';

/**
 * The wording guard (Phase 3, step 8a/8g): the app is called Harness on screen, a session is never an
 * "instance" in new text, and old status phrases stay out. Rule D (page titles) lives beside the control
 * surface registry. Run `npm run audit:ui-words -- --hits` to see what a failure is pointing at.
 */
const ROOT = resolve(__dirname, '../..');

interface AllowedHit {
  file: string | RegExp;
  pattern: RegExp;
  reason: string;
}

/** App-name hits that stay. A stale entry (one that matches nothing) fails, as in icon-control-tooltip.spec.ts. */
const ALLOWED_HITS: readonly AllowedHit[] = [
  { file: 'src/shared/glossary/glossary.ts', pattern: /^(?:AIO|AI Orchestrator|Orchestrator)$/, reason: 'the glossary lists the names to avoid' },
  { file: /^src\/main\/cli\/.*\.ts$/, pattern: /attachments in orchestrator mode/, reason: 'internal signal matched by orchestrator-attachment-fallback.ts; the person sees the plain "left out" message' },
  { file: 'src/main/instance/context-worker-client.ts', pattern: /\[(?:End )?Orchestrator Memory Context\]/, reason: 'prompt delimiter the model and the parser both expect' },
  { file: 'src/main/instance/instance-context.ts', pattern: /\[(?:End )?Orchestrator Memory Context\]/, reason: 'prompt delimiter the model and the parser both expect' },
  { file: 'src/main/orchestration/harness-guidance.ts', pattern: /\[(?:End )?Orchestrator Memory Context\]/, reason: 'prompt delimiter the model and the parser both expect' },
  { file: 'src/main/orchestration/orchestration-protocol.ts', pattern: /\[Orchestrator Response\]/, reason: 'prompt delimiter the model and the parser both expect' },
  { file: 'src/main/instance/acp-history-reconciliation.ts', pattern: /## You Are an Orchestrator/, reason: 'retired prompt heading, matched so old sessions are still recognised' },
  { file: 'src/main/memory/wake-context-builder.ts', pattern: /AI orchestrator assistant/, reason: 'text for the model, not for a person' },
  { file: 'src/shared/types/agent.types.ts', pattern: /PLAN MODE[\s\S]*orchestrator/, reason: 'plan-mode prompt for the model' },
  { file: 'src/main/hooks/hook-executor.ts', pattern: /security evaluator for an AI orchestrator/, reason: 'prompt for the checking model' },
  { file: 'src/main/ipc/orchestration-ipc-handler.ts', pattern: /parent orchestrator/, reason: 'prompt sent to a helper agent, not shown to a person' },
  { file: 'src/main/orchestration/consensus-coordinator.ts', pattern: /orchestrator commands/, reason: 'prompt that names the command set the model must not use' },
  { file: 'src/main/orchestration/consensus-prompt-utils.ts', pattern: /orchestrator commands/, reason: 'prompt that names the command set the model must not use' },
];

/** Where the old status phrases may still appear as visible strings. */
const ALLOWED_STATUS_WORDS: readonly AllowedHit[] = [];

interface Baseline {
  counts: Record<string, number>;
}

let scan: ScanResult;
let appHits: UiTextHit[];

beforeAll(() => {
  scan = scanUiText(ROOT);
  appHits = appNameHits(scan.strings);
}, 120_000);

const isAllowed = (hit: UiTextHit, allowed: readonly AllowedHit[]) => allowed.some((entry) =>
  (typeof entry.file === 'string' ? entry.file === hit.file : entry.file.test(hit.file)) && entry.pattern.test(hit.text));

const describeHits = (hits: readonly UiTextHit[]) => hits.map((hit) => `${hit.file}:${hit.line} [${hit.match}] ${hit.text.slice(0, 90)}`);

describe('UI vocabulary guard', () => {
  it('visits at least 600 renderer files and reaches the string floor, so it can never scan nothing', () => {
    expect(scan.rendererFilesVisited).toBeGreaterThanOrEqual(600);
    // About 80% of the 78,000 strings the extractor read when this floor was set.
    expect(scan.stringsScanned).toBeGreaterThanOrEqual(62_000);
  });

  it('shows no app name on screen outside the allowlist (Rule A: zero tolerance)', () => {
    expect(describeHits(appHits.filter((hit) => !isAllowed(hit, ALLOWED_HITS)))).toEqual([]);
  });

  it('has an allowlist whose every entry still matches something', () => {
    const stale = [...ALLOWED_HITS, ...ALLOWED_STATUS_WORDS].filter((entry) => !appHits.concat(statusWordHits(scan.strings)).some((hit) => isAllowed(hit, [entry])));
    expect(stale.map((entry) => `${String(entry.file)} ${entry.pattern}`)).toEqual([]);
  });

  it('keeps "instance" and "thread" in renderer and shared copy at or below the baseline (Rule B)', () => {
    const baseline = JSON.parse(readFileSync(resolve(ROOT, 'scripts/ui-text/ui-vocabulary-baseline.json'), 'utf8')) as Baseline;
    const grown = Object.entries(countByFile(instanceThreadHits(scan.strings)))
      .filter(([file, count]) => count > (baseline.counts[file] ?? 0))
      .map(([file, count]) => `${file}: ${count} now, ${baseline.counts[file] ?? 0} allowed`);
    expect(grown).toEqual([]);
  });

  it('keeps the old status phrases out of visible strings (Rule E)', () => {
    const hits = statusWordHits(scan.strings).filter((hit) => !isAllowed(hit, ALLOWED_STATUS_WORDS));
    expect(describeHits(hits)).toEqual([]);
  });
});
