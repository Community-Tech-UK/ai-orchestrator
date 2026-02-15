/**
 * SWE-bench Adapter - Wraps Claude CLI for SWE-bench task execution
 *
 * Takes a SWE-bench problem statement and generates a patch using
 * either vanilla Claude or the orchestrator.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { SWEBenchTask, SWEBenchResult } from './types.js';

const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per task

/**
 * Generate a patch using vanilla Claude CLI
 */
export async function generatePatchVanilla(
  task: SWEBenchTask,
  workDir: string
): Promise<SWEBenchResult> {
  const startTime = Date.now();
  const startedAt = startTime;

  try {
    const prompt = buildSWEBenchPrompt(task, 'vanilla');
    const output = await invokeClaude(prompt, workDir, CLAUDE_TIMEOUT_MS);

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
 * Since we can't import the actual orchestrator here, we simulate
 * multi-agent coordination by making multiple Claude CLI calls:
 * 1. Planning phase - analyze the issue and plan the solution
 * 2. Implementation phase - generate the patch
 * 3. Review phase - validate and refine the patch
 */
export async function generatePatchOrchestrator(
  task: SWEBenchTask,
  workDir: string
): Promise<SWEBenchResult> {
  const startTime = Date.now();
  const startedAt = startTime;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let agentTurns = 0;

  try {
    // Phase 1: Planning
    const planPrompt = buildPlanningPrompt(task);
    const planOutput = await invokeClaude(planPrompt, workDir, CLAUDE_TIMEOUT_MS / 3);
    const planResult = parseClaudeOutput(planOutput);
    totalInputTokens += planResult.inputTokens;
    totalOutputTokens += planResult.outputTokens;
    agentTurns++;

    // Phase 2: Implementation
    const implPrompt = buildImplementationPrompt(task, planResult.content);
    const implOutput = await invokeClaude(implPrompt, workDir, CLAUDE_TIMEOUT_MS / 3);
    const implResult = parseClaudeOutput(implOutput);
    totalInputTokens += implResult.inputTokens;
    totalOutputTokens += implResult.outputTokens;
    agentTurns++;

    // Phase 3: Review
    const reviewPrompt = buildReviewPrompt(task, implResult.content);
    const reviewOutput = await invokeClaude(reviewPrompt, workDir, CLAUDE_TIMEOUT_MS / 3);
    const reviewResult = parseClaudeOutput(reviewOutput);
    totalInputTokens += reviewResult.inputTokens;
    totalOutputTokens += reviewResult.outputTokens;
    agentTurns++;

    // Extract final patch from review output
    let patch = extractPatchFromOutput(reviewResult.content);

    // Fallback to implementation output if review doesn't have a patch
    if (!patch) {
      patch = extractPatchFromOutput(implResult.content);
    }

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
 * Build the main prompt for vanilla Claude
 */
function buildSWEBenchPrompt(task: SWEBenchTask, mode: 'vanilla' | 'orchestrator'): string {
  const hintsSection = task.hints_text ? `\n\nHints:\n${task.hints_text}` : '';

  return `You are an expert software engineer. You are given a GitHub issue from the ${task.repo} repository and need to generate a patch to fix it.

Repository: ${task.repo}
Base Commit: ${task.baseCommit}
Version: ${task.version}

Issue Description:
${task.problem_statement}${hintsSection}

Your task:
1. Analyze the issue carefully
2. Identify the files that need to be changed
3. Generate a unified diff patch that resolves the issue
4. Ensure your patch applies cleanly to the base commit

Output your patch in unified diff format, enclosed in a \`\`\`diff code block.

Important:
- Your patch must be a valid unified diff
- Include file paths relative to the repository root
- Ensure proper context lines (usually 3 lines before and after changes)
- The patch must be complete and apply cleanly with \`git apply\`

Generate the patch now:`;
}

/**
 * Build planning prompt for orchestrator
 */
function buildPlanningPrompt(task: SWEBenchTask): string {
  const hintsSection = task.hints_text ? `\n\nHints:\n${task.hints_text}` : '';

  return `You are a planning agent in a software engineering team. Analyze this GitHub issue and create a solution plan.

Repository: ${task.repo}
Base Commit: ${task.baseCommit}
Version: ${task.version}

Issue Description:
${task.problem_statement}${hintsSection}

Create a detailed plan that includes:
1. Root cause analysis - what is the underlying issue?
2. Affected files - which files need to be modified?
3. Solution approach - how should this be fixed?
4. Edge cases - what scenarios should be handled?
5. Testing strategy - how to verify the fix?

Provide your analysis and plan:`;
}

/**
 * Build implementation prompt for orchestrator
 */
function buildImplementationPrompt(task: SWEBenchTask, plan: string): string {
  return `You are an implementation agent. Based on the following plan, generate a patch to fix the issue.

Issue: ${task.instanceId}
Repository: ${task.repo}

Plan from planning agent:
${plan}

Now generate a unified diff patch that implements this plan. The patch must:
- Be a valid unified diff format
- Include all necessary file changes
- Apply cleanly to base commit ${task.baseCommit}
- Handle all edge cases mentioned in the plan

Output the patch enclosed in a \`\`\`diff code block:`;
}

/**
 * Build review prompt for orchestrator
 */
function buildReviewPrompt(task: SWEBenchTask, implementation: string): string {
  return `You are a review agent. Review and validate the following patch implementation.

Issue: ${task.instanceId}
Repository: ${task.repo}

Implementation:
${implementation}

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
 * Invoke Claude CLI and capture output
 */
function invokeClaude(prompt: string, workDir: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--output-format', 'json'];

    const child = spawn('claude', args, {
      cwd: workDir,
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

    // Send prompt via stdin
    child.stdin.write(prompt);
    child.stdin.end();

    // Timeout handler
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
 * Parse Claude CLI JSON output to extract content and token usage
 */
function parseClaudeOutput(output: string): {
  content: string;
  inputTokens: number;
  outputTokens: number;
} {
  try {
    // Claude CLI --output-format json produces JSON lines
    const lines = output.trim().split('\n');
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);

        // Accumulate content from assistant messages
        if (json.type === 'assistant' || json.type === 'content') {
          content += json.content || json.text || '';
        }

        // Extract token usage
        if (json.usage) {
          inputTokens += json.usage.input_tokens || 0;
          outputTokens += json.usage.output_tokens || 0;
        }

        // Also check top-level token fields
        if (json.input_tokens) inputTokens += json.input_tokens;
        if (json.output_tokens) outputTokens += json.output_tokens;
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
  } catch (error) {
    // Fallback: treat entire output as content
    return { content: output.trim(), inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * Write a patch to disk
 */
export function writePatch(patch: string, outputPath: string): void {
  writeFileSync(outputPath, patch, 'utf-8');
}

/**
 * Read a patch from disk
 */
export function readPatch(patchPath: string): string {
  if (!existsSync(patchPath)) {
    throw new Error(`Patch file not found: ${patchPath}`);
  }
  return readFileSync(patchPath, 'utf-8');
}
