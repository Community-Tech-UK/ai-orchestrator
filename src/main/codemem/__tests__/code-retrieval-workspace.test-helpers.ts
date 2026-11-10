/**
 * The code-retrieval workspace shared by the default-suite checks (`code-retrieval-load.spec.ts`) and the timed
 * search ceiling in the slow tier (`soak.spec.ts`): 500 small source files whose names and words differ only by
 * number, plus generated files in `node_modules/pkg`, `dist` and `build` that must never be indexed.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect } from 'vitest';
import type { CodeRetrievalService } from '../code-retrieval-service';

const SOURCE_FILES = 500;
const GENERATED_FOLDERS = ['node_modules/pkg', 'dist', 'build'];

export async function writeRetrievalWorkspace(workDir: string, generatedPerFolder: number): Promise<void> {
  const files: { path: string; content: string }[] = [];
  for (let index = 0; index < SOURCE_FILES; index += 1) {
    const suffix = index.toString().padStart(4, '0');
    files.push({
      path: join(workDir, 'src', `file-${suffix}.ts`),
      content: [
        `export function uniqueSourceToken${suffix}(): string {`,
        `  return 'unique source token ${suffix}';`,
        '}',
        '',
      ].join('\n'),
    });
  }
  for (const folder of GENERATED_FOLDERS) {
    const extension = folder === 'node_modules/pkg' ? 'ts' : 'js';
    for (let index = 0; index < generatedPerFolder; index += 1) {
      const suffix = index.toString().padStart(4, '0');
      files.push({
        path: join(workDir, folder, `file-${suffix}.${extension}`),
        content: `export const generatedDependencyToken${suffix} = 'generated dependency token';\n`,
      });
    }
  }
  await mkdir(join(workDir, 'src'), { recursive: true });
  for (const folder of GENERATED_FOLDERS) await mkdir(join(workDir, folder), { recursive: true });
  for (let offset = 0; offset < files.length; offset += 100) {
    await Promise.all(files.slice(offset, offset + 100).map((file) => writeFile(file.path, file.content, 'utf8')));
  }
}

/**
 * Ten searches spread across all 500 source files (`file-0007`, `0057` … `0457`). Each must rank its own file
 * first, from the full-text index, with every result inside the size bound. Returns the slowest search in ms.
 */
export async function searchAcrossSources(retrieval: CodeRetrievalService, workDir: string): Promise<number> {
  let slowestMs = 0;
  for (let index = 0; index < 10; index += 1) {
    const suffix = (index * 50 + 7).toString().padStart(4, '0');
    const start = performance.now();
    const results = await retrieval.search({ workspacePath: workDir, query: `unique source token ${suffix}`, limit: 5 });
    slowestMs = Math.max(slowestMs, performance.now() - start);

    expect(results[0]).toEqual(expect.objectContaining({ relativePath: `src/file-${suffix}.ts`, source: 'fts' }));
    expect(results.every((result) => result.content.length <= 3600)).toBe(true);
  }
  return slowestMs;
}
