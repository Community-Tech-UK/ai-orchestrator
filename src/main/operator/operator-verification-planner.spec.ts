import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { planProjectVerification } from './operator-verification-planner';

describe('planProjectVerification', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(tempPaths.map((tempPath) => fs.rm(tempPath, { recursive: true, force: true })));
    tempPaths.length = 0;
  });

  it('detects TypeScript npm projects and chooses non-watch test arguments', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-verify-node-'));
    tempPaths.push(projectPath);
    await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'vitest',
        lint: 'eslint .',
      },
    }), 'utf-8');
    await fs.writeFile(path.join(projectPath, 'tsconfig.json'), '{}', 'utf-8');

    const plan = await planProjectVerification(projectPath);

    expect(plan.kinds).toEqual(['node', 'typescript']);
    expect(plan.checks).toEqual([
      expect.objectContaining({ label: 'typecheck', command: 'npm', args: ['run', 'typecheck'], required: true }),
      expect.objectContaining({ label: 'test', command: 'npm', args: ['test', '--', '--run', '--watch=false'], required: true }),
      expect.objectContaining({ label: 'lint', command: 'npm', args: ['run', 'lint'], required: false }),
    ]);
  });

  it('detects non-Node project types in documented priority order', async () => {
    const rustPath = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-verify-rust-'));
    const goPath = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-verify-go-'));
    tempPaths.push(rustPath, goPath);
    await fs.writeFile(path.join(rustPath, 'Cargo.toml'), '[package]\nname = "demo"\n', 'utf-8');
    await fs.writeFile(path.join(rustPath, 'go.mod'), 'module demo\n', 'utf-8');
    await fs.writeFile(path.join(goPath, 'go.mod'), 'module demo\n', 'utf-8');

    await expect(planProjectVerification(rustPath)).resolves.toMatchObject({
      kinds: ['rust'],
      checks: [expect.objectContaining({ command: 'cargo', args: ['test'], required: true })],
    });
    await expect(planProjectVerification(goPath)).resolves.toMatchObject({
      kinds: ['go'],
      checks: [expect.objectContaining({ command: 'go', args: ['test', './...'], required: true })],
    });
  });

  it('returns an explicit no-automated-verification fallback for unknown projects', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-verify-unknown-'));
    tempPaths.push(projectPath);

    await expect(planProjectVerification(projectPath)).resolves.toEqual({
      projectPath,
      kinds: ['unknown'],
      checks: [],
      fallbackReason: 'No recognized project manifest found',
    });
  });
});
