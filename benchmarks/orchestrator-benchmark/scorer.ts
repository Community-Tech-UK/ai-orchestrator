/**
 * Scorer - Evaluates benchmark outputs against ground truth
 *
 * For known-answer tasks (KA-1 through KA-4), this compares
 * the model's output against the computed ground truth.
 *
 * Note: KA-5 (trace task) was moved to RC-6 as trace completeness is subjective.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { BenchmarkTask, KnownAnswerScore, NeedleDefinition, NiahScore } from './types.js';

const GROUND_TRUTH_PATH = join(import.meta.dirname, 'tasks/setup/ground-truth.json');

interface GroundTruth {
  generatedAt: string;
  tasks: {
    'KA-1': {
      totalCount: number;
      handlers: { channel: string; file: string }[];
    };
    'KA-2': {
      totalCount: number;
      singletons: { className: string; file: string }[];
    };
    'KA-3': {
      totalCount: number;
      importingFiles: { file: string }[];
    };
    'KA-4': {
      totalCount: number;
      bugs: { id: string; description: string }[];
    };
  };
}

let cachedGroundTruth: GroundTruth | null = null;

/**
 * Load ground truth from file
 */
function loadGroundTruth(): GroundTruth {
  if (cachedGroundTruth) return cachedGroundTruth;

  if (!existsSync(GROUND_TRUTH_PATH)) {
    throw new Error(
      `Ground truth not found at ${GROUND_TRUTH_PATH}. Run: npx ts-node tasks/setup/ground-truth.ts`
    );
  }

  cachedGroundTruth = JSON.parse(readFileSync(GROUND_TRUTH_PATH, 'utf-8'));
  return cachedGroundTruth!;
}

/**
 * Score a known-answer task output against ground truth
 */
export function scoreKnownAnswer(task: BenchmarkTask, output: string): KnownAnswerScore {
  switch (task.id) {
    case 'KA-1':
      return scoreKA1(output);
    case 'KA-2':
      return scoreKA2(output);
    case 'KA-3':
      return scoreKA3(output);
    case 'KA-4':
      return scoreKA4(output);
    default:
      throw new Error(`Unknown known-answer task: ${task.id}`);
  }
}

/**
 * KA-1: Score IPC handler detection
 * Checks if output mentions the expected IPC channels
 */
function scoreKA1(output: string): KnownAnswerScore {
  const gt = loadGroundTruth().tasks['KA-1'];
  const outputLower = output.toLowerCase();

  let found = 0;
  let falseNegatives = 0;
  const expectedChannels = gt.handlers.map(h => h.channel);

  for (const channel of expectedChannels) {
    // Check if the channel name appears in output
    if (outputLower.includes(channel.toLowerCase())) {
      found++;
    } else {
      falseNegatives++;
    }
  }

  // Check for false positives (mentioned channels not in ground truth)
  // This is approximate - look for patterns like "ipcMain.handle('something')"
  const mentionedChannels = extractMentionedChannels(output);
  const falsePositives = mentionedChannels.filter(
    c => !expectedChannels.some(ec => ec.toLowerCase() === c.toLowerCase())
  ).length;

  const correctness = gt.totalCount > 0 ? (found / gt.totalCount) * 100 : 0;

  return {
    correctness: Math.round(correctness * 10) / 10,
    falseNegatives,
    falsePositives,
  };
}

/**
 * KA-2: Score singleton service detection
 */
function scoreKA2(output: string): KnownAnswerScore {
  const gt = loadGroundTruth().tasks['KA-2'];
  const outputLower = output.toLowerCase();

  let found = 0;
  let falseNegatives = 0;
  const expectedClasses = gt.singletons.map(s => s.className);

  for (const className of expectedClasses) {
    if (outputLower.includes(className.toLowerCase())) {
      found++;
    } else {
      falseNegatives++;
    }
  }

  // Check for false positives - classes mentioned that aren't singletons
  const mentionedClasses = extractMentionedClasses(output);
  const falsePositives = mentionedClasses.filter(
    c => !expectedClasses.some(ec => ec.toLowerCase() === c.toLowerCase())
  ).length;

  const correctness = gt.totalCount > 0 ? (found / gt.totalCount) * 100 : 0;

  return {
    correctness: Math.round(correctness * 10) / 10,
    falseNegatives,
    falsePositives,
  };
}

/**
 * KA-3: Score orchestration-handler import detection
 */
function scoreKA3(output: string): KnownAnswerScore {
  const gt = loadGroundTruth().tasks['KA-3'];
  const outputLower = output.toLowerCase();

  let found = 0;
  let falseNegatives = 0;
  const expectedFiles = gt.importingFiles.map(f => f.file);

  for (const file of expectedFiles) {
    // Extract just the filename without path for more flexible matching
    const fileName = file.split('/').pop() || file;
    if (outputLower.includes(fileName.toLowerCase().replace('.ts', ''))) {
      found++;
    } else {
      falseNegatives++;
    }
  }

  // For this task, false positives are less meaningful
  const falsePositives = 0;

  const correctness = gt.totalCount > 0 ? (found / gt.totalCount) * 100 : 0;

  return {
    correctness: Math.round(correctness * 10) / 10,
    falseNegatives,
    falsePositives,
  };
}

/**
 * KA-4: Score bug detection
 */
function scoreKA4(output: string): KnownAnswerScore {
  const gt = loadGroundTruth().tasks['KA-4'];
  const outputLower = output.toLowerCase();

  let found = 0;
  let falseNegatives = 0;

  // Check if each bug's key characteristics are mentioned
  const bugIndicators = [
    ['off-by-one', 'indexof', 'includes', 'first child'],  // BUG-001
    ['null', 'undefined', 'assertion', 'non-null'],        // BUG-002
    ['timeout', 'multiplier', '1000', 'minutes'],          // BUG-003
  ];

  for (let i = 0; i < gt.bugs.length; i++) {
    const indicators = bugIndicators[i] || [];
    const matchCount = indicators.filter(ind => outputLower.includes(ind)).length;

    // Consider found if at least 2 indicators match
    if (matchCount >= 2) {
      found++;
    } else {
      falseNegatives++;
    }
  }

  // Check if output mentions bugs that don't exist
  const bugMentions = (output.match(/bug/gi) || []).length;
  const falsePositives = Math.max(0, bugMentions - gt.totalCount - 3); // Allow some leeway

  const correctness = gt.totalCount > 0 ? (found / gt.totalCount) * 100 : 0;

  return {
    correctness: Math.round(correctness * 10) / 10,
    falseNegatives,
    falsePositives,
  };
}

// Helper functions

function extractMentionedChannels(output: string): string[] {
  // Look for patterns like 'CHANNEL_NAME' or "channel-name"
  const matches = output.match(/['"`]([A-Z_]+(?:_[A-Z_]+)*|[a-z-]+(?:-[a-z]+)*)['"`]/g) || [];
  return matches
    .map(m => m.replace(/['"`]/g, ''))
    .filter(m => m.includes('_') || m.includes('-'));
}

function extractMentionedClasses(output: string): string[] {
  // Look for PascalCase class names
  const matches = output.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
  return [...new Set(matches)];
}

/**
 * Check if ground truth exists
 */
export function hasGroundTruth(): boolean {
  return existsSync(GROUND_TRUTH_PATH);
}

/**
 * Score a NIAH (Needle In A Haystack) task output.
 * Checks whether the planted needles were successfully retrieved.
 */
export function scoreNiah(task: BenchmarkTask, output: string): NiahScore {
  if (!task.expectedRetrieval || !task.needles?.length) {
    throw new Error(`Task ${task.id} is not a valid NIAH task (missing expectedRetrieval or needles)`);
  }

  const outputLower = output.toLowerCase();
  const { requiredFacts, acceptableVariants, requiresMultiNeedleReasoning } = task.expectedRetrieval;

  // Score each needle based on whether its key facts appear in the output
  const needleResults = task.needles
    .filter(n => !n.id.startsWith('decoy-')) // Skip decoy needles (they're distractors)
    .map(needle => {
      const found = checkNeedleRetrieval(needle, requiredFacts, acceptableVariants, outputLower);
      return {
        needleId: needle.id,
        found: found.retrieved,
        exactMatch: found.exact,
      };
    });

  const retrievedCount = needleResults.filter(r => r.found).length;
  const totalNeedles = needleResults.length;
  const retrievalAccuracy = totalNeedles > 0
    ? Math.round((retrievedCount / totalNeedles) * 1000) / 10
    : 0;

  // For reasoning tasks, check if the synthesized answer is present
  let reasoningCorrect: boolean | undefined;
  if (requiresMultiNeedleReasoning && acceptableVariants?.length) {
    // The last variant group typically contains the reasoning answer
    const reasoningVariants = acceptableVariants[acceptableVariants.length - 1];
    reasoningCorrect = reasoningVariants?.some(v => outputLower.includes(v.toLowerCase())) ?? false;
  }

  return {
    retrievalAccuracy,
    needleResults,
    reasoningCorrect,
  };
}

/**
 * Check if a specific needle's facts were retrieved in the output.
 */
function checkNeedleRetrieval(
  needle: NeedleDefinition,
  requiredFacts: string[],
  acceptableVariants: string[][] | undefined,
  outputLower: string
): { retrieved: boolean; exact: boolean } {
  const needleContentLower = needle.content.toLowerCase();

  let exactMatches = 0;
  let variantMatches = 0;

  for (let i = 0; i < requiredFacts.length; i++) {
    const fact = requiredFacts[i];
    // Only count facts that are relevant to this needle
    if (!needleContentLower.includes(fact.toLowerCase())) continue;

    if (outputLower.includes(fact.toLowerCase())) {
      exactMatches++;
    } else if (acceptableVariants?.[i]) {
      const hasVariant = acceptableVariants[i].some(v =>
        outputLower.includes(v.toLowerCase())
      );
      if (hasVariant) variantMatches++;
    }
  }

  const totalMatches = exactMatches + variantMatches;
  return {
    retrieved: totalMatches > 0,
    exact: exactMatches > 0 && variantMatches === 0,
  };
}

/**
 * Convert a NIAH score to a 0-100 correctness value for unified reporting.
 */
export function niahScoreToCorrectness(score: NiahScore): number {
  let base = score.retrievalAccuracy;
  if (score.reasoningCorrect === true) {
    base = Math.min(100, base + 10);
  } else if (score.reasoningCorrect === false) {
    base = Math.max(0, base - 10);
  }
  return Math.round(base * 10) / 10;
}
