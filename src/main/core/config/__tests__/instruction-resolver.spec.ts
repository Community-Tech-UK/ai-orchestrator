import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  createInstructionMigrationDraft,
  resolveInstructionStack,
} from '../instruction-resolver';

describe('instruction-resolver', () => {
  let tempRoot: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'instruction-resolver-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = tempRoot;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('merges global and project instruction files in priority order', async () => {
    const projectDir = path.join(tempRoot, 'repo');
    await fs.mkdir(path.join(tempRoot, '.orchestrator'), { recursive: true });
    await fs.mkdir(path.join(projectDir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, '.orchestrator', 'INSTRUCTIONS.md'),
      'Global instructions',
    );
    await fs.writeFile(
      path.join(projectDir, 'AGENTS.md'),
      'Project AGENTS',
    );
    await fs.writeFile(
      path.join(projectDir, '.orchestrator', 'INSTRUCTIONS.md'),
      'Project orchestrator instructions',
    );

    const resolution = await resolveInstructionStack({
      workingDirectory: projectDir,
    });

    expect(resolution.mergedContent).toContain('Global instructions');
    expect(resolution.mergedContent).toContain('Project AGENTS');
    expect(resolution.mergedContent).toContain('Project orchestrator instructions');
    expect(resolution.sources.filter((source) => source.loaded && source.applied)).toHaveLength(3);
  });

  it('applies the nearest AGENTS.md for a scoped context', async () => {
    const projectDir = path.join(tempRoot, 'repo');
    const scopedDir = path.join(projectDir, 'src', 'feature');
    await fs.mkdir(scopedDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'AGENTS.md'), 'Root AGENTS');
    await fs.writeFile(path.join(projectDir, 'src', 'AGENTS.md'), 'Scoped AGENTS');
    await fs.writeFile(path.join(scopedDir, 'file.ts'), 'export const value = 1;');

    const resolution = await resolveInstructionStack({
      workingDirectory: projectDir,
      contextPaths: [path.join(scopedDir, 'file.ts')],
    });

    const rootAgents = resolution.sources.find((source) => source.path === path.join(projectDir, 'AGENTS.md'));
    const scopedAgents = resolution.sources.find((source) => source.path === path.join(projectDir, 'src', 'AGENTS.md'));

    expect(rootAgents?.applied).toBe(true);
    expect(scopedAgents?.applied).toBe(true);
    expect(resolution.mergedContent).toContain('Scoped AGENTS');
  });

  it('matches copilot instruction files using applyTo frontmatter', async () => {
    const projectDir = path.join(tempRoot, 'repo');
    const instructionsDir = path.join(projectDir, '.github', 'instructions');
    const sourceFile = path.join(projectDir, 'src', 'app', 'example.ts');
    await fs.mkdir(instructionsDir, { recursive: true });
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, 'export const example = true;');
    await fs.writeFile(
      path.join(instructionsDir, 'typescript.instructions.md'),
      [
        '---',
        'applyTo: "src/**/*.ts"',
        '---',
        '',
        'Use strict TypeScript rules.',
        '',
      ].join('\n'),
    );

    const resolution = await resolveInstructionStack({
      workingDirectory: projectDir,
      contextPaths: [sourceFile],
    });

    const scopedInstructions = resolution.sources.find((source) =>
      source.path.endsWith('typescript.instructions.md'),
    );

    expect(scopedInstructions?.applied).toBe(true);
    expect(scopedInstructions?.matchedPaths).toEqual(['src/app/example.ts']);
    expect(resolution.mergedContent).toContain('Use strict TypeScript rules.');
  });

  it('creates a migration draft in .orchestrator/INSTRUCTIONS.md', async () => {
    const projectDir = path.join(tempRoot, 'repo');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'AGENTS.md'), 'Project AGENTS');

    const resolution = await resolveInstructionStack({
      workingDirectory: projectDir,
    });
    const draft = createInstructionMigrationDraft(resolution);

    expect(draft.outputPath).toBe(path.join(projectDir, '.orchestrator', 'INSTRUCTIONS.md'));
    expect(draft.content).toContain('## Imported Sources');
    expect(draft.content).toContain('Project AGENTS');
  });
});
