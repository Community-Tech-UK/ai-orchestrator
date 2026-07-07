/**
 * SWE-bench Adapter - Wraps Claude CLI for SWE-bench task execution
 *
 * Takes a SWE-bench problem statement and generates a patch using
 * either vanilla Claude or the orchestrator.
 */

import { spawn, execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { SWEBenchTask, SWEBenchResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per task

/** Orchestrator phase — drives model selection and prompt behavior */
type Phase = 'plan' | 'implement' | 'review' | 'vanilla';

/** Phase time budgets as fractions of the total timeout */
const PHASE_BUDGETS = {
  plan: 0.40,     // 40% — explore + plan
  implement: 0.40, // 40% — generate patch
  review: 0.20,    // 20% — validate/refine
} as const;

/**
 * Generate a patch using vanilla Claude CLI
 */
export async function generatePatchVanilla(
  task: SWEBenchTask,
  workDir: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<SWEBenchResult> {
  const startTime = Date.now();
  const startedAt = startTime;

  try {
    const prompt = buildSWEBenchPrompt(task, 'vanilla');
    const output = await invokeClaude(prompt, workDir, timeoutMs, 'vanilla');

    // Parse JSON response for token usage
    const { content, inputTokens, outputTokens } = parseClaudeOutput(output);

    // Extract patch from output
    const patch = extractPatchFromOutput(content);

    if (!patch) {
      return {
        instanceId: task.instanceId,
        system: 'vanilla',
        patch: '',
        resolved: false,
        tokensUsed: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - startTime,
        agentTurns: 1,
        startedAt,
        completedAt: Date.now(),
        error: 'Failed to extract patch from model output',
      };
    }

    return {
      instanceId: task.instanceId,
      system: 'vanilla',
      patch,
      resolved: false, // Will be determined by evaluation
      tokensUsed: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - startTime,
      agentTurns: 1,
      startedAt,
      completedAt: Date.now(),
    };
  } catch (error) {
    return {
      instanceId: task.instanceId,
      system: 'vanilla',
      patch: '',
      resolved: false,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startTime,
      agentTurns: 1,
      startedAt,
      completedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generate a patch using orchestrator-style multi-agent coordination
 *
 * Uses a budget-based timeout system: the total timeout is divided across
 * phases, with unused time from earlier phases rolling forward. Each phase
 * has graceful degradation — if it times out, we recover partial output
 * and continue with subsequent phases using whatever context we have.
 *
 * Phases:
 * 1. Planning — explore repo and analyze the issue
 * 2. Implementation — generate the patch based on the plan
 * 3. Review — validate and refine (skipped if time is tight or patch looks good)
 */
export async function generatePatchOrchestrator(
  task: SWEBenchTask,
  workDir: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<SWEBenchResult> {
  const startTime = Date.now();
  const startedAt = startTime;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let agentTurns = 0;
  const totalBudgetMs = timeoutMs;

  /** Calculate remaining time budget */
  const remainingMs = () => totalBudgetMs - (Date.now() - startTime);

  /** Minimum time to bother starting a phase (reduced to 1 min to allow late saves) */
  const MIN_PHASE_MS = 60 * 1000;

  try {
    // ── Phase 1: Planning ──────────────────────────────────────────
    const planBudgetMs = Math.min(
      totalBudgetMs * PHASE_BUDGETS.plan,
      remainingMs() - MIN_PHASE_MS // leave room for at least one more phase
    );

    let planContent = '';
    if (planBudgetMs >= MIN_PHASE_MS) {
      const planPrompt = buildPlanningPrompt(task);
      const planOutput = await invokeClaudeGraceful(planPrompt, workDir, planBudgetMs, 'plan');
      const planResult = parseClaudeOutput(planOutput.output);
      totalInputTokens += planResult.inputTokens;
      totalOutputTokens += planResult.outputTokens;
      agentTurns++;
      planContent = planResult.content;

      if (planOutput.timedOut) {
        console.log('      ⏱️  Planning phase timed out, continuing with partial plan');
      }

      // Futility check: if planning produced nothing useful, fall back to single-shot
      if (planContent && !hasUsefulContent(planContent, 'plan')) {
        console.log('      ⚠️  Plan has no file references, falling back to single-shot');
        planContent = ''; // Clear so implementation uses vanilla-style prompt
      }
    }

    // ── Phase 2: Implementation ────────────────────────────────────
    // Give implementation all remaining time minus review budget
    const reviewReserveMs = Math.max(MIN_PHASE_MS, totalBudgetMs * PHASE_BUDGETS.review);
    const implBudgetMs = Math.max(MIN_PHASE_MS, remainingMs() - reviewReserveMs);

    let implContent = '';
    let implPatch = '';
    if (implBudgetMs >= MIN_PHASE_MS) {
      const implPrompt = planContent
        ? buildImplementationPrompt(task, planContent)
        : buildSWEBenchPrompt(task, 'orchestrator'); // Fallback: act like vanilla if no plan
      const implOutput = await invokeClaudeGraceful(implPrompt, workDir, implBudgetMs, 'implement');
      const implResult = parseClaudeOutput(implOutput.output);
      totalInputTokens += implResult.inputTokens;
      totalOutputTokens += implResult.outputTokens;
      agentTurns++;
      implContent = implResult.content;
      implPatch = extractPatchFromOutput(implContent);

      if (implOutput.timedOut) {
        console.log('      ⏱️  Implementation phase timed out, attempting patch recovery');
      }
    }

    // ── Patch Validation Gate ────────────────────────────────────────
    let patchValid = false;
    let applyError = '';
    if (implPatch) {
      const checkPath = join(workDir, 'temp_check.patch');
      try {
        writeFileSync(checkPath, implPatch);
        execSync('git apply --check temp_check.patch', { cwd: workDir, stdio: 'pipe' });
        patchValid = true;
      } catch (e) {
        applyError = e instanceof Error ? e.message : String(e);
      } finally {
        try { unlinkSync(checkPath); } catch { /* ignore */ }
      }
    }

    // ── Phase 3: Review (conditional) ─────────────────────────────
    const reviewBudgetMs = remainingMs();
    let reviewPatch = '';

    const shouldSkipReview =
      reviewBudgetMs < MIN_PHASE_MS ||
      !implContent ||
      !implPatch ||
      (patchValid && isPatchSmallAndFocused(implPatch));

    if (shouldSkipReview && patchValid) {
      // Patch is valid and small — skip review entirely
      console.log('      ✅ Patch passes git apply --check, skipping LLM review to save tokens');
      reviewPatch = implPatch;
    } else if (!shouldSkipReview) {
      // Run review — pass apply error if patch was invalid so reviewer can fix
      const reviewPrompt = patchValid
        ? buildReviewPrompt(task, implContent)
        : buildReviewPrompt(task, implContent, applyError || undefined);
      console.log(patchValid
        ? '      🔍 Running LLM review (large patch)'
        : '      🔧 Patch failed git apply --check, sending to review for repair');
      const reviewOutput = await invokeClaudeGraceful(reviewPrompt, workDir, reviewBudgetMs, 'review');
      const reviewResult = parseClaudeOutput(reviewOutput.output);
      totalInputTokens += reviewResult.inputTokens;
      totalOutputTokens += reviewResult.outputTokens;
      agentTurns++;
      reviewPatch = extractPatchFromOutput(reviewResult.content);

      if (reviewOutput.timedOut) {
        console.log('      ⏱️  Review phase timed out, using implementation patch');
      }
    }

    // ── Select best patch ──────────────────────────────────────────
    // Prefer review patch (refined) > implementation patch > plan patch (rare)
    const patch = reviewPatch || implPatch || extractPatchFromOutput(planContent);

    if (!patch) {
      return {
        instanceId: task.instanceId,
        system: 'orchestrator',
        patch: '',
        resolved: false,
        tokensUsed: totalInputTokens + totalOutputTokens,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        durationMs: Date.now() - startTime,
        agentTurns,
        startedAt,
        completedAt: Date.now(),
        error: 'Failed to extract patch from orchestrator output',
      };
    }

    return {
      instanceId: task.instanceId,
      system: 'orchestrator',
      patch,
      resolved: false, // Will be determined by evaluation
      tokensUsed: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      durationMs: Date.now() - startTime,
      agentTurns,
      startedAt,
      completedAt: Date.now(),
    };
  } catch (error) {
    return {
      instanceId: task.instanceId,
      system: 'orchestrator',
      patch: '',
      resolved: false,
      tokensUsed: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      durationMs: Date.now() - startTime,
      agentTurns,
      startedAt,
      completedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build common context for all phases to maximize prompt caching.
 * Putting the heavy context (repo info + problem statement) first allows
 * the API to cache it across different phases/processes.
 */
function buildCommonContext(task: SWEBenchTask): string {
  const hintsSection = task.hints_text ? `\n\nHints:\n${task.hints_text}` : '';
  return `Repository: ${task.repo}
Commit: ${task.baseCommit.substring(0, 12)} (version ${task.version})
Working Directory: Current directory (full source available)

Issue Description:
${task.problem_statement}${hintsSection}
`;
}

/**
 * Build the main prompt for vanilla Claude
 */
function buildSWEBenchPrompt(task: SWEBenchTask, mode: 'vanilla' | 'orchestrator'): string {
  const context = buildCommonContext(task);
  
  return `${context}

You are an expert software engineer.
Your task:
1. Explore the repository to understand the relevant code (use grep, find, cat etc.)
2. Identify the root cause of the issue
3. Make the minimal code changes needed to fix the issue
4. Generate a unified diff patch of your changes

IMPORTANT INSTRUCTIONS:
- Explore the codebase first. The full source is available in the current directory.
- Output your final patch in unified diff format, enclosed in a \`\`\`diff code block.
- The patch must be a valid unified diff with proper context lines (3 lines before/after)
- Include file paths relative to the repository root
- The patch must apply cleanly with \`git apply\`
- Make minimal changes — fix only what's needed

Generate the patch now:`;
}

/**
 * Build planning prompt for orchestrator
 */
function buildPlanningPrompt(task: SWEBenchTask): string {
  const context = buildCommonContext(task);

  return `${context}

You are a localization and planning agent. Follow this exact process:

STEP 1 — FILE LOCALIZATION
Search the repository to find the 3-5 most relevant files. Use grep/find to search for:
- Error messages or keywords from the issue
- Class/function names mentioned in the issue
- Related test files
List each file with a one-line reason why it's relevant.

STEP 2 — FUNCTION LOCALIZATION
For each relevant file, identify the specific function(s) or class(es) that need modification.
Cite exact function names and line numbers.

STEP 3 — ROOT CAUSE
Based on the localized code, explain the root cause in 2-3 sentences.

STEP 4 — FIX PLAN
For each function that needs changes:
- File path
- Function name and line number
- What to change (be specific about the logic change)
- Any edge cases to handle

Keep your response concise and structured. Do not write code — only specify locations and changes.`;
}

/**
 * Build implementation prompt for orchestrator
 */
/**
 * Compress a plan to its most actionable content to reduce input tokens.
 * Priority: file paths > structured content > code references.
 */
function compressPlan(plan: string, maxChars = 8000): string {
  const lines = plan.split('\n');

  // Priority 1: Lines with file paths (most actionable for implementation)
  const fileRefs = lines.filter(l =>
    /\.(py|js|ts|java|go|rb|rs|c|cpp|h|css|html)\b/.test(l) || /line\s+\d+/i.test(l)
  );

  // Priority 2: Structured content (bullets, numbers, headers)
  const structured = lines.filter(l => /^\s*[0-9]+\.|^\s*[-*]|^\s*#/.test(l));

  // Priority 3: Lines with code references (backticks, function/class keywords)
  const codeRefs = lines.filter(l =>
    /`[^`]+`/.test(l) || /\b(def|class|function|method|import)\b/.test(l)
  );

  // Combine, deduplicate, preserve order
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const line of [...fileRefs, ...structured, ...codeRefs]) {
    if (!seen.has(line)) {
      seen.add(line);
      combined.push(line);
    }
  }

  // Cap at 50 lines and maxChars
  const capped = combined.slice(0, 50).join('\n');
  return capped.length > maxChars ? capped.substring(0, maxChars) : capped;
}

function buildImplementationPrompt(task: SWEBenchTask, plan: string): string {
  const context = buildCommonContext(task);
  const compressedPlan = compressPlan(plan);

  return `${context}

You are an implementation agent. Generate a minimal patch to fix the issue based on this plan.

Plan Summary:
${compressedPlan}

INSTRUCTIONS:
- Output ONLY a unified diff patch in a \`\`\`diff code block
- Make the MINIMUM changes needed — do not refactor unrelated code
- The patch must apply cleanly with \`git apply\`
- Include proper context lines (3 lines before/after changes)
- File paths must be relative to the repository root

\`\`\`diff code block:`;
}

/**
 * Build review prompt for orchestrator
 */
function buildReviewPrompt(task: SWEBenchTask, implementation: string, error?: string): string {
  const context = buildCommonContext(task);
  const errorContext = error ? `\n\nReview Trigger: The previous patch failed to apply.\nError: ${error}` : '';

  return `${context}

You are a review agent. Review and validate the following patch implementation.

Implementation:
${implementation}${errorContext}

Review the patch for:
1. Correctness - does it solve the issue?
2. Completeness - are all cases handled?
3. Code quality - is it well-structured?
4. Potential issues - any bugs or edge cases?

If the patch is good, output it in final form in a \`\`\`diff code block.
If it needs fixes, provide the corrected patch in a \`\`\`diff code block.

Final patch:`;
}

/**
 * Check whether a phase produced useful, actionable content.
 * Used for futility detection — if a phase fails to produce
 * meaningful output, we can abort early and fall back.
 */
function hasUsefulContent(output: string, phase: Phase): boolean {
  if (!output || output.trim().length < 50) return false;

  if (phase === 'plan') {
    // A useful plan should reference at least one source file
    return /\.(py|js|ts|java|go|rb|rs|c|cpp|h)\b/.test(output);
  }

  if (phase === 'implement') {
    // Implementation should contain diff markers
    return output.includes('diff --git') ||
      (output.includes('---') && output.includes('+++'));
  }

  return true;
}

/**
 * Check if a patch is small and focused enough to skip LLM review.
 * Small patches (1-2 files, <30 changed lines) are unlikely to benefit
 * from a full review pass.
 */
function isPatchSmallAndFocused(patch: string): boolean {
  const lines = patch.split('\n');
  const changedFiles = lines.filter(l => l.startsWith('diff --git')).length;
  const changedLines = lines.filter(l =>
    (l.startsWith('+') && !l.startsWith('+++')) ||
    (l.startsWith('-') && !l.startsWith('---'))
  ).length;
  return changedFiles <= 2 && changedLines < 30;
}

/**
 * Extract unified diff patch from model output
 */
export function extractPatchFromOutput(output: string): string {
  // Try to extract from ```diff code block
  const diffBlockMatch = output.match(/```diff\s*\n([\s\S]*?)\n```/);
  if (diffBlockMatch) {
    return diffBlockMatch[1].trim();
  }

  // Try to extract from plain ```  block
  const codeBlockMatch = output.match(/```\s*\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    const content = codeBlockMatch[1].trim();
    // Check if it looks like a diff
    if (content.includes('diff --git') || content.includes('---') && content.includes('+++')) {
      return content;
    }
  }

  // Look for git format-patch style
  const gitPatchMatch = output.match(/diff --git[\s\S]*?(?=\n(?:diff --git|$))/g);
  if (gitPatchMatch && gitPatchMatch.length > 0) {
    return gitPatchMatch.join('\n').trim();
  }

  // Look for unified diff markers (--- and +++)
  const unifiedDiffMatch = output.match(/^---[\s\S]*?\+\+\+[\s\S]*?(?=\n(?:---|$))/m);
  if (unifiedDiffMatch) {
    return unifiedDiffMatch[0].trim();
  }

  // No patch found
  return '';
}

/**
 * Invoke Claude CLI and capture output.
 * On timeout, rejects with an error (no partial recovery).
 */
function invokeClaude(prompt: string, workDir: string, timeoutMs: number, phase?: Phase): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs(phase);
    const env = buildClaudeEnv();

    const child = spawn('claude', args, {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}:\n${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to spawn Claude CLI: ${error.message}`));
    });

    // Handle stdin errors (EPIPE if process exits before write completes)
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') {
        stderr += `stdin error: ${err.message}\n`;
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

/**
 * Invoke Claude CLI with graceful timeout handling.
 * On timeout, returns whatever partial output has been captured so far
 * instead of throwing. This allows later phases to continue with
 * partial context rather than losing everything.
 */
function invokeClaudeGraceful(
  prompt: string,
  workDir: string,
  timeoutMs: number,
  phase?: Phase
): Promise<{ output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const args = buildClaudeArgs(phase);
    const env = buildClaudeEnv();

    const child = spawn('claude', args, {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let didTimeout = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (didTimeout) {
        // Return partial output on timeout
        resolve({ output: stdout, timedOut: true });
      } else if (code !== 0) {
        // Non-zero exit but not timeout — still return what we have
        resolve({ output: stdout || stderr, timedOut: false });
      } else {
        resolve({ output: stdout, timedOut: false });
      }
    });

    child.on('error', (error) => {
      // Spawn failure — resolve with empty output so orchestrator can continue
      resolve({ output: '', timedOut: false });
    });

    // Handle stdin errors (EPIPE if process exits before write completes)
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') {
        stderr += `stdin error: ${err.message}\n`;
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();

    const timeout = setTimeout(() => {
      didTimeout = true;
      child.kill('SIGTERM');
      // Give the process 5s to write final output before SIGKILL
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5000);
    }, timeoutMs);

    child.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

/** Select model based on orchestrator phase */
function getModelForPhase(phase: Phase): string | undefined {
  switch (phase) {
    case 'plan':
    case 'review':
      // Sonnet for analysis phases — cheaper, still accurate
      return 'claude-sonnet-4-20250514';
    case 'implement':
    case 'vanilla':
      // Default CLI model for code generation (needs precision)
      return undefined;
  }
}

/** Build common Claude CLI arguments */
function buildClaudeArgs(phase?: Phase): string[] {
  const args = [
    '--print',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--max-turns', '15',
  ];
  const model = phase ? getModelForPhase(phase) : undefined;
  if (model) {
    args.push('--model', model);
  }
  return args;
}

/** Build environment for Claude CLI (strip CLAUDECODE to allow nesting) */
function buildClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['CLAUDECODE'];
  return env;
}

/**
 * Parse Claude CLI JSON output to extract content and token usage
 */
function parseClaudeOutput(output: string): {
  content: string;
  inputTokens: number;
  outputTokens: number;
} {
  try {
    // Claude CLI --print --output-format json produces a single JSON object
    // with type "result" containing the response in `result` field
    const lines = output.trim().split('\n');
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);

        // Handle the result object (from --print --output-format json)
        if (json.type === 'result' && json.result) {
          content += json.result;

          // Extract token usage from the result object
          if (json.usage) {
            inputTokens += json.usage.input_tokens || 0;
            outputTokens += json.usage.output_tokens || 0;
            // Also check cache tokens as part of input
            inputTokens += json.usage.cache_read_input_tokens || 0;
            inputTokens += json.usage.cache_creation_input_tokens || 0;
          }

          // NOTE: json.modelUsage is a per-model breakdown of the SAME data
          // as json.usage — do NOT sum both or tokens will be double-counted.

          continue;
        }

        // Handle streaming assistant messages
        if (json.type === 'assistant' || json.type === 'content') {
          content += json.content || json.text || '';
        }

        // Extract token usage from other message types
        if (json.usage && json.type !== 'result') {
          inputTokens += json.usage.input_tokens || 0;
          outputTokens += json.usage.output_tokens || 0;
        }
      } catch {
        // Not JSON, might be plain text - append to content
        content += line + '\n';
      }
    }

    // Fallback: if no JSON parsing succeeded, treat entire output as content
    if (!content && output) {
      content = output;
    }

    return { content: content.trim(), inputTokens, outputTokens };
  } catch {
    // Fallback: treat entire output as content
    return { content: output.trim(), inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * Classify a task's difficulty based on heuristics.
 * Used by the runner to route easy tasks to the vanilla fast-path.
 */
export function classifyDifficulty(task: SWEBenchTask): 'easy' | 'medium' | 'hard' {
  const issueLength = task.problem_statement.length;
  let failTests = 0;
  try {
    const parsed = typeof task.FAIL_TO_PASS === 'string'
      ? JSON.parse(task.FAIL_TO_PASS)
      : task.FAIL_TO_PASS;
    failTests = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    failTests = 0;
  }
  const hasHints = !!task.hints_text?.trim();

  // Easy: short issue, single test, has hints
  if (issueLength < 500 && failTests <= 1 && hasHints) return 'easy';

  // Hard: long issue or many failing tests
  if (issueLength > 2000 || failTests > 3) return 'hard';

  return 'medium';
}

/**
 * Write a patch to disk
 */
export function writePatch(patch: string, outputPath: string): void {
  writeFileSync(outputPath, patch, 'utf-8');
}
