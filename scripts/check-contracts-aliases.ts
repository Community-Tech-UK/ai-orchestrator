import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_SYNC_POINTS = [
  'tsconfig.json',
  'tsconfig.electron.json',
  'src/main/register-aliases.ts',
  'vitest.config.ts',
] as const;

export interface AliasSyncFile {
  path: string;
  content: string;
}

export interface AliasSyncIssue {
  subpath: string;
  expected: string;
  file: string;
  message: string;
}

interface ContractsPackageJson {
  exports?: Record<string, unknown>;
}

export function stripComments(content: string): string {
  let output = '';
  let inString: false | '"' | '\'' | '`' = false;
  let escaped = false;

  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    const next = content[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === inString) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      inString = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') {
        index++;
      }
      output += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
        if (content[index] === '\n') {
          output += '\n';
        }
        index++;
      }
      index++;
      continue;
    }

    output += char;
  }

  return output;
}

export function discoverSchemaSubpathsFromExports(exportsMap: Record<string, unknown> = {}): string[] {
  return Object.keys(exportsMap)
    .filter((key) => key.startsWith('./schemas/'))
    .map((key) => key.slice('./schemas/'.length))
    .sort((left, right) => left.localeCompare(right));
}

export function findMissingAliases(
  subpaths: readonly string[],
  files: readonly AliasSyncFile[],
): AliasSyncIssue[] {
  const issues: AliasSyncIssue[] = [];
  const byPath = new Map(files.map((file) => [file.path, stripComments(file.content)]));

  for (const subpath of subpaths) {
    const expected = `@contracts/schemas/${subpath}`;
    for (const syncPoint of REQUIRED_SYNC_POINTS) {
      const content = byPath.get(syncPoint);
      if (content === undefined) {
        issues.push({
          subpath,
          expected,
          file: syncPoint,
          message: `Missing sync file '${syncPoint}'`,
        });
        continue;
      }
      if (!content.includes(expected)) {
        issues.push({
          subpath,
          expected,
          file: syncPoint,
          message: `Missing alias '${expected}' in '${syncPoint}'`,
        });
      }
    }
  }

  return issues;
}

export function checkContractsAliases(root = process.cwd()): {
  subpaths: string[];
  issues: AliasSyncIssue[];
} {
  const packageJsonPath = join(root, 'packages/contracts/package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as ContractsPackageJson;
  const subpaths = discoverSchemaSubpathsFromExports(pkg.exports);
  const files = REQUIRED_SYNC_POINTS.map((file) => ({
    path: file,
    content: readFileSync(join(root, file), 'utf-8'),
  }));

  const issues = findMissingAliases(subpaths, files);
  for (const subpath of subpaths) {
    const schemaFile = join(root, 'packages/contracts/src/schemas', `${subpath}.schemas.ts`);
    if (!existsSync(schemaFile)) {
      issues.push({
        subpath,
        expected: schemaFile,
        file: 'packages/contracts/package.json',
        message: `Exported schema subpath '${subpath}' points to a missing schema file`,
      });
    }
  }

  return { subpaths, issues };
}

function main(): void {
  const { subpaths, issues } = checkContractsAliases();
  if (issues.length > 0) {
    console.error(`Contracts alias sync failed with ${issues.length} issue(s):`);
    for (const issue of issues) {
      console.error(`  - ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Contracts alias sync OK: ${subpaths.length} schema subpaths verified.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
