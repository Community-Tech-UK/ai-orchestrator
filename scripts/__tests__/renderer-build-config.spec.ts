import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

interface AngularWorkspaceConfig {
  projects: {
    'ai-orchestrator': {
      architect: {
        build: {
          options: {
            tsConfig: string;
          };
        };
      };
    };
  };
}

const workspaceRoot = process.cwd();
const angularConfig = JSON.parse(
  readFileSync(resolve(workspaceRoot, 'angular.json'), 'utf8'),
) as AngularWorkspaceConfig;

describe('renderer build TypeScript scope', () => {
  it('keeps main-process and script roots out of the Angular compiler program', () => {
    const buildOptions = angularConfig.projects['ai-orchestrator'].architect.build.options;
    const tsConfigPath = resolve(workspaceRoot, buildOptions.tsConfig);
    const config = ts.readConfigFile(tsConfigPath, ts.sys.readFile);

    expect(config.error).toBeUndefined();

    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      workspaceRoot,
      undefined,
      tsConfigPath,
    );
    const rootFiles = new Set(parsed.fileNames.map((file) => resolve(file)));

    expect(buildOptions.tsConfig).toBe('tsconfig.renderer.json');
    expect(rootFiles).toContain(resolve(workspaceRoot, 'src/renderer/main.ts'));
    expect(
      [...rootFiles].some((file) =>
        file.startsWith(`${resolve(workspaceRoot, 'src/main')}${sep}`),
      ),
    ).toBe(false);
    expect(
      [...rootFiles].some((file) =>
        file.startsWith(`${resolve(workspaceRoot, 'scripts')}${sep}`),
      ),
    ).toBe(false);
  });
});
