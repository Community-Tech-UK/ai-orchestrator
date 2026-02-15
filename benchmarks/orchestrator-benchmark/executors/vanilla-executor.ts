/**
 * Vanilla Executor - Runs tasks using Claude CLI directly
 */

import { spawn } from 'child_process';
import { resolve } from 'path';
import type { BenchmarkTask, ExecutorResult, ContextStage, TokenUsageBreakdown } from '../types.js';

export interface VanillaExecutorOptions {
  /** Pre-filled context messages to send before the task */
  contextMessages?: string[];
  /** Maximum time to wait in milliseconds */
  timeoutMs?: number;
}

/**
 * Execute a task using vanilla Claude CLI
 */
export async function executeVanilla(
  task: BenchmarkTask,
  options: VanillaExecutorOptions = {}
): Promise<ExecutorResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? task.timeoutMinutes * 60 * 1000;
  const cwd = resolve(task.workingDirectory);

  let output = '';
  let tokensUsed = 0;
  const tokenBreakdown: TokenUsageBreakdown = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  return new Promise((resolvePromise) => {
    // Spawn claude CLI in print mode for non-interactive execution
    const args = [
      '--print',  // Non-interactive, print response and exit
      '--output-format', 'json',  // Structured output for parsing
    ];

    // Build the full prompt including any context
    let fullPrompt = task.prompt;
    if (options.contextMessages && options.contextMessages.length > 0) {
      // Prepend context as part of the prompt
      const contextSection = options.contextMessages.join('\n\n---\n\n');
      fullPrompt = `Previous conversation context:\n${contextSection}\n\n---\n\nCurrent task:\n${task.prompt}`;
    }

    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // Send the prompt to stdin
    proc.stdin?.write(fullPrompt);
    proc.stdin?.end();

    // Set up timeout
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      resolvePromise({
        output: stdout || 'Timeout: Task exceeded time limit',
        tokensUsed,
        durationMs: Date.now() - startTime,
        error: `Timeout after ${timeoutMs}ms`
      });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      // Try to parse JSON output for structured data
      try {
        const lines = stdout.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);

            // Extract output text
            if (parsed.type === 'assistant' && parsed.message?.content) {
              for (const block of parsed.message.content) {
                if (block.type === 'text') {
                  output += block.text + '\n';
                }
              }
            }

            // Extract output text and token usage from result messages
            if (parsed.type === 'result') {
              if (parsed.result && typeof parsed.result === 'string') {
                output += parsed.result + '\n';
              }
              if (parsed.usage) {
                const inputTok = parsed.usage.input_tokens || 0;
                const outputTok = parsed.usage.output_tokens || 0;
                const cacheRead = parsed.usage.cache_read_input_tokens || 0;
                const cacheWrite = parsed.usage.cache_creation_input_tokens || 0;
                tokensUsed = inputTok + outputTok;
                tokenBreakdown.inputTokens = inputTok;
                tokenBreakdown.outputTokens = outputTok;
                tokenBreakdown.cacheReadTokens = cacheRead;
                tokenBreakdown.cacheWriteTokens = cacheWrite;
              }
            }

          } catch {
            // Not JSON, append as raw output
            output += line + '\n';
          }
        }
      } catch {
        // Fallback to raw output
        output = stdout;
      }

      const durationMs = Date.now() - startTime;

      resolvePromise({
        output: output.trim() || stdout.trim(),
        tokensUsed,
        tokenBreakdown,
        durationMs,
        error: code !== 0 ? `Exit code: ${code}. Stderr: ${stderr}` : undefined
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolvePromise({
        output: '',
        tokensUsed,
        durationMs: Date.now() - startTime,
        error: `Process error: ${err.message}`
      });
    });
  });
}

/**
 * Build context messages for a given context stage
 */
export function buildContextMessages(stage: ContextStage, workingDirectory: string): string[] {
  // This will be populated by context-filler.ts
  // Returns pre-built context appropriate for the stage
  switch (stage) {
    case 'fresh':
      return [];
    case 'moderate':
      // ~50k tokens of prior conversation
      return getModerateContextMessages(workingDirectory);
    case 'heavy':
      // ~100k+ tokens of prior conversation
      return getHeavyContextMessages(workingDirectory);
  }
}

function getModerateContextMessages(_workingDirectory: string): string[] {
  // Placeholder - will be implemented in context-filler.ts
  return [
    'Previous task: Explored the codebase structure and identified main components.',
    'Previous task: Analyzed the instance management system.',
    'Previous task: Reviewed the IPC communication patterns.',
  ];
}

function getHeavyContextMessages(_workingDirectory: string): string[] {
  // Placeholder - will be implemented in context-filler.ts
  return [
    ...getModerateContextMessages(_workingDirectory),
    'Previous task: Deep dive into orchestration handler implementation.',
    'Previous task: Analyzed all error handling paths.',
    'Previous task: Reviewed memory management and caching systems.',
    'Previous task: Traced request flow from UI to backend.',
    'Previous task: Examined test coverage and testing patterns.',
  ];
}
