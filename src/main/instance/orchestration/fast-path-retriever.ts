import { spawn } from 'child_process';
import { getLogger } from '../../logging/logger';
import {
  getIndexedCodebaseContextService,
  type IndexedCodebaseContextService,
} from '../../indexing/indexed-codebase-context';
import type { FastPathResult } from '../instance-types';

const logger = getLogger('FastPathRetriever');
const FAST_PATH_COMMAND_TIMEOUT_MS = 2_500;
const FAST_PATH_MAX_OUTPUT_BYTES = 256 * 1024;

export interface FastPathRetrieverDeps {
  indexedCodebaseContext?: Pick<IndexedCodebaseContextService, 'buildFastPathResult'>;
}

export class FastPathRetriever {
  constructor(private readonly deps: FastPathRetrieverDeps = {}) {}

  async search(task: string, cwd: string): Promise<FastPathResult | null> {
    const terms = this.extractQueryTerms(task);
    const pattern = terms.length > 0 ? this.buildLexicalPattern(terms) : '';
    const lineLimit = 40;

    const indexedResult = await this.searchIndexedCodebase(task, cwd);
    if (indexedResult) {
      return indexedResult;
    }

    if (this.isListFilesTask(task) || !pattern) {
      const fileList = await this.listFiles(cwd);
      if (!fileList) return null;
      const filtered =
        terms.length > 0
          ? fileList.files.filter((file) =>
              terms.some((term) => file.toLowerCase().includes(term))
            )
          : fileList.files;
      const lines = filtered.slice(0, lineLimit);
      return {
        mode: 'files',
        command: fileList.command,
        args: fileList.args,
        totalMatches: filtered.length,
        lines,
        rawOutput: filtered.join('\n'),
        cwd,
      };
    }

    const result = await this.grep(pattern, cwd);
    if (!result) return null;

    const lines = result.rawOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, lineLimit);

    return {
      mode: 'grep',
      command: result.command,
      args: result.args,
      totalMatches: result.totalMatches,
      lines,
      rawOutput: result.rawOutput,
      cwd,
    };
  }

  async listFiles(cwd: string): Promise<{ files: string[]; command: string; args: string[] } | null> {
    const gitArgs = ['ls-files'];
    const gitResult = await this.runCommand(
      'git',
      gitArgs,
      cwd,
      FAST_PATH_COMMAND_TIMEOUT_MS,
    );
    if (gitResult && gitResult.exitCode === 0) {
      const files = gitResult.stdout.split('\n').filter(Boolean);
      return { files, command: 'git', args: gitArgs };
    }

    const rgArgs = [
      '--files',
      '--max-depth',
      '3',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!dist/**',
      '--glob',
      '!build/**',
      '--glob',
      '!.git/**',
    ];
    const rgResult = await this.runCommand(
      'rg',
      rgArgs,
      cwd,
      FAST_PATH_COMMAND_TIMEOUT_MS,
    );
    if (rgResult && rgResult.exitCode === 0) {
      const files = rgResult.stdout.split('\n').filter(Boolean);
      return { files, command: 'rg', args: rgArgs };
    }

    return null;
  }

  async grep(
    pattern: string,
    cwd: string,
  ): Promise<{
    command: string;
    args: string[];
    rawOutput: string;
    totalMatches: number;
  } | null> {
    const rgArgs = ['-n', '--no-heading', '-S', pattern, '.'];
    const rgResult = await this.runCommand(
      'rg',
      rgArgs,
      cwd,
      FAST_PATH_COMMAND_TIMEOUT_MS,
    );
    if (rgResult && (rgResult.exitCode === 0 || rgResult.exitCode === 1)) {
      const output = rgResult.stdout || '';
      const lines = output.split('\n').filter(Boolean);
      return {
        command: 'rg',
        args: rgArgs,
        rawOutput: output,
        totalMatches: lines.length,
      };
    }

    const gitArgs = ['grep', '-n', '-e', pattern];
    const gitResult = await this.runCommand(
      'git',
      gitArgs,
      cwd,
      FAST_PATH_COMMAND_TIMEOUT_MS,
    );
    if (gitResult && (gitResult.exitCode === 0 || gitResult.exitCode === 1)) {
      const output = gitResult.stdout || '';
      const lines = output.split('\n').filter(Boolean);
      return {
        command: 'git',
        args: gitArgs,
        rawOutput: output,
        totalMatches: lines.length,
      };
    }

    return null;
  }

  buildSummary(task: string, result: FastPathResult): string {
    const matchLabel = result.mode === 'files' ? 'files' : 'matches';
    const shown = result.lines.length;
    const total = result.totalMatches;
    const header = `Fast-path retrieval complete (${matchLabel}: ${total}, showing ${shown}).`;
    const commandLine =
      `Command: ${result.command} ${result.args.join(' ')}`.trim();
    const lines =
      result.lines.length > 0 ? result.lines.join('\n') : 'No matches found.';

    return [
      '[Fast Retrieval]',
      header,
      `Task: ${task}`,
      commandLine,
      lines,
      '[End Fast Retrieval]',
    ].join('\n');
  }

  private async searchIndexedCodebase(
    task: string,
    cwd: string,
  ): Promise<FastPathResult | null> {
    try {
      const service = this.deps.indexedCodebaseContext ?? getIndexedCodebaseContextService();
      return await service.buildFastPathResult({
        workspacePath: cwd,
        query: task,
        maxTokens: 900,
        topK: 8,
      });
    } catch (error) {
      logger.debug('Indexed codebase fast-path search unavailable', {
        cwd,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async runCommand(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  } | null> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, { cwd });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let outputBytes = 0;
      let timer: NodeJS.Timeout | null = null;

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve({ stdout, stderr, exitCode });
      };

      const appendOutput = (target: 'stdout' | 'stderr', data: Buffer | string): void => {
        const chunk = data.toString();
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > FAST_PATH_MAX_OUTPUT_BYTES) {
          proc.kill('SIGTERM');
          finish(null);
          return;
        }
        if (target === 'stdout') {
          stdout += chunk;
        } else {
          stderr += chunk;
        }
      };

      proc.stdout?.on('data', (data) => {
        appendOutput('stdout', data);
      });
      proc.stderr?.on('data', (data) => {
        appendOutput('stderr', data);
      });
      proc.on('error', () => finish(null));
      proc.on('close', (code) => finish(code));

      timer = setTimeout(() => {
        proc.kill('SIGTERM');
        finish(proc.exitCode ?? null);
      }, timeoutMs);
    });
  }

  private isListFilesTask(task: string): boolean {
    const text = task.toLowerCase();
    return (
      text.includes('list files') ||
      text.includes('file list') ||
      text.includes('show files') ||
      text.includes('files in') ||
      text.includes('list directories')
    );
  }

  private extractQueryTerms(message: string): string[] {
    const matches = message.toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
    const unique = Array.from(
      new Set(matches.filter((term) => term.length >= 4))
    );
    return unique.slice(0, 12);
  }

  private buildLexicalPattern(terms: string[]): string {
    return terms
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
  }
}
