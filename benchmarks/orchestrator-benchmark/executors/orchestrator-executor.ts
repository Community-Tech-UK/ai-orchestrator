/**
 * Orchestrator Executor - Runs tasks using AI Orchestrator
 *
 * This executor launches the Electron app in headless/test mode
 * and sends the task to an orchestrator instance that can spawn children.
 */

import { spawn, ChildProcess } from 'child_process';
import { resolve, join } from 'path';
import { createServer, Server } from 'http';
import type { BenchmarkTask, ExecutorResult, ContextStage } from '../types.js';

export interface OrchestratorExecutorOptions {
  /** Pre-filled context messages to send before the task */
  contextMessages?: string[];
  /** Maximum time to wait in milliseconds */
  timeoutMs?: number;
  /** Port for benchmark communication server */
  benchmarkPort?: number;
}

interface BenchmarkMessage {
  type: 'output' | 'file_read' | 'tokens' | 'complete' | 'error';
  data: unknown;
}

/**
 * Execute a task using AI Orchestrator
 */
export async function executeOrchestrator(
  task: BenchmarkTask,
  options: OrchestratorExecutorOptions = {}
): Promise<ExecutorResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? task.timeoutMinutes * 60 * 1000;
  const cwd = resolve(task.workingDirectory);
  const benchmarkPort = options.benchmarkPort ?? 9876;

  let output = '';
  let tokensUsed = 0;
  const filesExamined: string[] = [];
  let electronProc: ChildProcess | null = null;
  let server: Server | null = null;

  return new Promise((resolvePromise) => {
    // Create a simple HTTP server to receive benchmark data from Electron
    server = createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const msg: BenchmarkMessage = JSON.parse(body);
            handleBenchmarkMessage(msg);
          } catch (e) {
            console.error('Failed to parse benchmark message:', e);
          }
          res.writeHead(200);
          res.end('OK');
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    function handleBenchmarkMessage(msg: BenchmarkMessage) {
      switch (msg.type) {
        case 'output':
          output += String(msg.data) + '\n';
          break;
        case 'file_read':
          const filePath = String(msg.data);
          if (!filesExamined.includes(filePath)) {
            filesExamined.push(filePath);
          }
          break;
        case 'tokens':
          tokensUsed += Number(msg.data) || 0;
          break;
        case 'complete':
          cleanup();
          resolvePromise({
            output: output.trim(),
            filesExamined,
            tokensUsed,
            durationMs: Date.now() - startTime
          });
          break;
        case 'error':
          cleanup();
          resolvePromise({
            output: output.trim(),
            filesExamined,
            tokensUsed,
            durationMs: Date.now() - startTime,
            error: String(msg.data)
          });
          break;
      }
    }

    function cleanup() {
      if (timeout) clearTimeout(timeout);
      if (electronProc) {
        electronProc.kill('SIGTERM');
        electronProc = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    }

    server.listen(benchmarkPort, '127.0.0.1', () => {
      // Build the full prompt including any context
      let fullPrompt = task.prompt;
      if (options.contextMessages && options.contextMessages.length > 0) {
        const contextSection = options.contextMessages.join('\n\n---\n\n');
        fullPrompt = `Previous conversation context:\n${contextSection}\n\n---\n\nCurrent task:\n${task.prompt}`;
      }

      // Launch Electron in benchmark mode
      const electronPath = join(import.meta.dirname, '../../../node_modules/.bin/electron');
      const mainPath = join(import.meta.dirname, '../../../dist/main/main.js');

      electronProc = spawn(electronPath, [mainPath], {
        cwd,
        env: {
          ...process.env,
          BENCHMARK_MODE: 'true',
          BENCHMARK_PORT: String(benchmarkPort),
          BENCHMARK_PROMPT: fullPrompt,
          BENCHMARK_WORKING_DIR: cwd,
          // Disable GPU for headless operation
          ELECTRON_DISABLE_GPU: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      electronProc.stdout?.on('data', (data) => {
        // Capture any stdout for debugging
        const text = data.toString();
        if (text.includes('[BENCHMARK]')) {
          console.log(text);
        }
      });

      electronProc.stderr?.on('data', (data) => {
        // Log errors but don't fail
        const text = data.toString();
        if (!text.includes('DevTools') && !text.includes('GPU')) {
          console.error('[Orchestrator stderr]:', text);
        }
      });

      electronProc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          cleanup();
          resolvePromise({
            output: output.trim(),
            filesExamined,
            tokensUsed,
            durationMs: Date.now() - startTime,
            error: `Electron exited with code ${code}`
          });
        }
      });

      electronProc.on('error', (err) => {
        cleanup();
        resolvePromise({
          output: '',
          filesExamined,
          tokensUsed,
          durationMs: Date.now() - startTime,
          error: `Failed to launch Electron: ${err.message}`
        });
      });
    });

    // Set up timeout
    const timeout = setTimeout(() => {
      cleanup();
      resolvePromise({
        output: output.trim() || 'Timeout: Task exceeded time limit',
        filesExamined,
        tokensUsed,
        durationMs: Date.now() - startTime,
        error: `Timeout after ${timeoutMs}ms`
      });
    }, timeoutMs);
  });
}

/**
 * Alternative: Execute via IPC to running Orchestrator instance
 * Use this if Orchestrator is already running
 */
export async function executeOrchestratorIPC(
  task: BenchmarkTask,
  options: OrchestratorExecutorOptions = {}
): Promise<ExecutorResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? task.timeoutMinutes * 60 * 1000;
  const cwd = resolve(task.workingDirectory);

  // Build the full prompt
  let fullPrompt = task.prompt;
  if (options.contextMessages && options.contextMessages.length > 0) {
    const contextSection = options.contextMessages.join('\n\n---\n\n');
    fullPrompt = `Previous conversation context:\n${contextSection}\n\n---\n\nCurrent task:\n${task.prompt}`;
  }

  // TODO: Implement IPC communication with running Orchestrator
  // This would connect to the Electron app's IPC interface
  // For now, return a placeholder

  return {
    output: 'IPC execution not yet implemented',
    filesExamined: [],
    tokensUsed: 0,
    durationMs: Date.now() - startTime,
    error: 'IPC execution not yet implemented - use executeOrchestrator instead'
  };
}

/**
 * Build context messages for a given context stage
 * (Same as vanilla executor for consistency)
 */
export function buildContextMessages(stage: ContextStage, workingDirectory: string): string[] {
  switch (stage) {
    case 'fresh':
      return [];
    case 'moderate':
      return getModerateContextMessages(workingDirectory);
    case 'heavy':
      return getHeavyContextMessages(workingDirectory);
  }
}

function getModerateContextMessages(_workingDirectory: string): string[] {
  return [
    'Previous task: Explored the codebase structure and identified main components.',
    'Previous task: Analyzed the instance management system.',
    'Previous task: Reviewed the IPC communication patterns.',
  ];
}

function getHeavyContextMessages(_workingDirectory: string): string[] {
  return [
    ...getModerateContextMessages(_workingDirectory),
    'Previous task: Deep dive into orchestration handler implementation.',
    'Previous task: Analyzed all error handling paths.',
    'Previous task: Reviewed memory management and caching systems.',
    'Previous task: Traced request flow from UI to backend.',
    'Previous task: Examined test coverage and testing patterns.',
  ];
}
