/**
 * Context Filler - Generates realistic conversation history to pre-fill context
 *
 * This module creates conversation content that simulates prior work sessions
 * to test how well each system handles tasks with accumulated context.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { ContextStage } from './types.js';

/**
 * Approximate tokens per character (rough estimate for English text + code)
 */
const TOKENS_PER_CHAR = 0.25;

/**
 * Target token counts for each context stage
 */
const CONTEXT_TARGETS: Record<ContextStage, number> = {
  fresh: 0,
  moderate: 50_000,
  heavy: 100_000,
};

export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ContextFillResult {
  messages: ContextMessage[];
  estimatedTokens: number;
}

/**
 * Generate context messages for a given stage
 */
export function generateContext(
  stage: ContextStage,
  workingDirectory: string
): ContextFillResult {
  if (stage === 'fresh') {
    return { messages: [], estimatedTokens: 0 };
  }

  const targetTokens = CONTEXT_TARGETS[stage];
  const messages: ContextMessage[] = [];
  let totalChars = 0;

  // Strategy: Build realistic conversation history by simulating
  // codebase exploration tasks that would accumulate context

  // 1. Initial codebase overview
  messages.push(...generateCodebaseOverview(workingDirectory));
  totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);

  // 2. File exploration tasks
  const filesToExplore = selectFilesForExploration(workingDirectory);
  for (const filePath of filesToExplore) {
    if (totalChars * TOKENS_PER_CHAR >= targetTokens) break;

    const exploration = generateFileExploration(workingDirectory, filePath);
    messages.push(...exploration);
    totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  }

  // 3. Analysis tasks (to fill remaining context)
  const analysisTasks = [
    'architecture',
    'error-handling',
    'testing-patterns',
    'dependencies',
  ];

  for (const task of analysisTasks) {
    if (totalChars * TOKENS_PER_CHAR >= targetTokens) break;

    const analysis = generateAnalysisTask(workingDirectory, task);
    messages.push(...analysis);
    totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  }

  return {
    messages,
    estimatedTokens: Math.round(totalChars * TOKENS_PER_CHAR),
  };
}

/**
 * Generate initial codebase overview conversation
 */
function generateCodebaseOverview(workingDirectory: string): ContextMessage[] {
  const messages: ContextMessage[] = [];

  // User asks for overview
  messages.push({
    role: 'user',
    content: 'Give me an overview of this codebase structure.',
  });

  // Assistant responds with directory listing
  const dirs = listTopLevelDirs(workingDirectory);
  const pkgJson = tryReadPackageJson(workingDirectory);

  let response = 'Here\'s an overview of the codebase:\n\n';
  response += '## Project Structure\n\n';
  response += dirs.map(d => `- \`${d}/\``).join('\n');
  response += '\n\n';

  if (pkgJson) {
    response += '## Package Info\n\n';
    response += `- Name: ${pkgJson['name'] || 'unknown'}\n`;
    response += `- Description: ${pkgJson['description'] || 'No description'}\n`;
    if (pkgJson['dependencies']) {
      const deps = Object.keys(pkgJson['dependencies'] as Record<string, unknown>).slice(0, 10);
      response += `- Key dependencies: ${deps.join(', ')}\n`;
    }
  }

  messages.push({
    role: 'assistant',
    content: response,
  });

  return messages;
}

/**
 * Generate file exploration conversation
 */
function generateFileExploration(
  workingDirectory: string,
  relativePath: string
): ContextMessage[] {
  const messages: ContextMessage[] = [];
  const fullPath = join(workingDirectory, relativePath);

  if (!existsSync(fullPath)) return messages;

  try {
    const content = readFileSync(fullPath, 'utf-8');

    // User asks to see file
    messages.push({
      role: 'user',
      content: `Show me the contents of ${relativePath}`,
    });

    // Assistant shows file (truncated if too large)
    const maxChars = 8000;
    const truncated = content.length > maxChars;
    const displayContent = truncated
      ? content.slice(0, maxChars) + '\n\n... (truncated)'
      : content;

    messages.push({
      role: 'assistant',
      content: `Here's the content of \`${relativePath}\`:\n\n\`\`\`typescript\n${displayContent}\n\`\`\``,
    });

    // User asks follow-up
    messages.push({
      role: 'user',
      content: `What are the main exports from this file?`,
    });

    // Assistant analyzes
    const exports = extractExports(content);
    messages.push({
      role: 'assistant',
      content: `The main exports from this file are:\n\n${exports.map(e => `- \`${e}\``).join('\n') || '- No explicit exports found'}`,
    });
  } catch {
    // Skip files that can't be read
  }

  return messages;
}

/**
 * Generate analysis task conversation
 */
function generateAnalysisTask(
  workingDirectory: string,
  taskType: string
): ContextMessage[] {
  const messages: ContextMessage[] = [];

  const prompts: Record<string, string> = {
    'architecture': 'Explain the high-level architecture of this application.',
    'error-handling': 'How does this codebase handle errors?',
    'testing-patterns': 'What testing patterns are used in this project?',
    'dependencies': 'What are the key external dependencies and why are they used?',
  };

  messages.push({
    role: 'user',
    content: prompts[taskType] || 'Analyze this aspect of the codebase.',
  });

  // Generate a realistic but synthetic response
  const responses: Record<string, string> = {
    'architecture': generateArchitectureResponse(workingDirectory),
    'error-handling': generateErrorHandlingResponse(),
    'testing-patterns': generateTestingResponse(),
    'dependencies': generateDependenciesResponse(workingDirectory),
  };

  messages.push({
    role: 'assistant',
    content: responses[taskType] || 'Analysis complete.',
  });

  return messages;
}

/**
 * Select files to explore for building context
 */
function selectFilesForExploration(workingDirectory: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number) {
    if (depth > 3) return;

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue;

        const fullPath = join(dir, entry);
        const relPath = relative(workingDirectory, fullPath);

        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath, depth + 1);
          } else if (stat.isFile() && entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
            if (!seen.has(relPath) && files.length < 20) {
              seen.add(relPath);
              files.push(relPath);
            }
          }
        } catch {
          // Skip inaccessible files
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  walk(workingDirectory, 0);
  return files;
}

// Helper functions

function listTopLevelDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(entry => {
        if (entry.startsWith('.') || entry === 'node_modules') return false;
        try {
          return statSync(join(dir, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .slice(0, 15);
  } catch {
    return [];
  }
}

function tryReadPackageJson(dir: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(join(dir, 'package.json'), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function extractExports(content: string): string[] {
  const exports: string[] = [];
  const patterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+const\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (!exports.includes(match[1])) {
        exports.push(match[1]);
      }
    }
  }

  return exports.slice(0, 20);
}

function generateArchitectureResponse(workingDirectory: string): string {
  const dirs = listTopLevelDirs(workingDirectory);
  let response = 'Based on my analysis, here\'s the architecture:\n\n';
  response += '## High-Level Structure\n\n';

  if (dirs.includes('src')) {
    response += 'The codebase follows a standard source organization:\n\n';
    const srcDirs = listTopLevelDirs(join(workingDirectory, 'src'));
    for (const dir of srcDirs) {
      response += `- **${dir}/**: `;
      if (dir === 'main') response += 'Main process code (Electron/Node.js)\n';
      else if (dir === 'renderer') response += 'Frontend/UI code\n';
      else if (dir === 'shared') response += 'Shared types and utilities\n';
      else if (dir === 'preload') response += 'Electron preload scripts\n';
      else response += `${dir} module\n`;
    }
  }

  response += '\n## Key Patterns\n\n';
  response += '- Singleton services for shared state\n';
  response += '- Event-driven communication between components\n';
  response += '- IPC for main/renderer process communication\n';

  return response;
}

function generateErrorHandlingResponse(): string {
  return `## Error Handling Patterns

The codebase uses several error handling approaches:

1. **Try-catch blocks** for synchronous operations
2. **Promise rejection handling** with .catch() or try/catch with async/await
3. **Event-based error propagation** for async operations
4. **Structured error types** with error codes and messages
5. **Logging integration** for error tracking

### Error Recovery
- Graceful degradation when possible
- Retry logic for transient failures
- User-facing error messages for recoverable errors`;
}

function generateTestingResponse(): string {
  return `## Testing Patterns

The project uses the following testing approaches:

1. **Unit tests** with Vitest for isolated component testing
2. **Integration tests** for multi-component workflows
3. **Mock patterns** for external dependencies

### Test Organization
- Tests co-located with source files (*.spec.ts)
- Shared test utilities and fixtures
- Singleton reset patterns for test isolation`;
}

function generateDependenciesResponse(workingDirectory: string): string {
  const pkgJson = tryReadPackageJson(workingDirectory);
  let response = '## Key Dependencies\n\n';

  if (pkgJson && pkgJson['dependencies']) {
    const deps = pkgJson['dependencies'] as Record<string, string>;
    const keyDeps = Object.entries(deps).slice(0, 10);

    for (const [name] of keyDeps) {
      response += `- **${name}**: `;
      if (name.includes('electron')) response += 'Desktop application framework\n';
      else if (name.includes('angular')) response += 'Frontend framework\n';
      else if (name.includes('rxjs')) response += 'Reactive programming\n';
      else if (name.includes('zod')) response += 'Schema validation\n';
      else response += 'Utility library\n';
    }
  }

  return response;
}

/**
 * Convert ContextMessage array to simple string array for executor
 */
export function contextMessagesToStrings(messages: ContextMessage[]): string[] {
  return messages.map(m => `[${m.role}]: ${m.content}`);
}
