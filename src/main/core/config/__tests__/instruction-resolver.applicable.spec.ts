import { execFile } from 'node:child_process';
import * as fs from 'fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveInstructionStack, type InstructionTrustGate } from '../instruction-resolver';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const execFileAsync = promisify(execFile);
const trustGate = { mode: 'off', evaluate: () => 'approved' } satisfies InstructionTrustGate;

describe('applicable instruction discovery for session startup', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'applicable-instructions-')));
    // Use a real repository so nested working directories resolve the same root.
    await execFileAsync('git', ['init', '--quiet', projectRoot]);
    await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'Required project instructions.');
    vi.mocked(fs.readdir).mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  function resolve(workingDirectory = projectRoot, contextPaths: string[] = []) {
    return resolveInstructionStack({ workingDirectory, contextPaths, discovery: 'applicable', trustGate });
  }

  it('loads root and custom instructions without enumerating unrelated subtrees or inactive Copilot rules', async () => {
    await fs.mkdir(path.join(projectRoot, 'other-project', 'deep'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'other-project', 'AGENTS.md'), 'Unrelated project instructions.');
    const instructionsDir = path.join(projectRoot, '.github', 'instructions');
    await fs.mkdir(instructionsDir, { recursive: true });
    await fs.writeFile(path.join(instructionsDir, 'inactive.instructions.md'), '---\napplyTo: "**/*.ts"\n---\nInactive rules.');
    const customPath = path.join(projectRoot, 'custom.md');
    await fs.writeFile(customPath, 'Required custom instructions.');

    const runtime = await resolveInstructionStack({
      workingDirectory: projectRoot, customPaths: [customPath], discovery: 'applicable', trustGate,
    });
    expect(runtime.mergedContent).toContain('Required project instructions.');
    expect(runtime.mergedContent).toContain('Required custom instructions.');
    expect(runtime.mergedContent).not.toContain('Unrelated project instructions.');
    expect(runtime.mergedContent).not.toContain('Inactive rules.');
    expect(fs.readdir).not.toHaveBeenCalled();

    const inventory = await resolveInstructionStack({ workingDirectory: projectRoot, customPaths: [customPath], trustGate });
    expect(inventory.mergedContent).toBe(runtime.mergedContent);
    expect(inventory.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: path.join(projectRoot, 'other-project', 'AGENTS.md'), loaded: true, applied: false }),
      expect.objectContaining({ path: path.join(instructionsDir, 'inactive.instructions.md'), loaded: true, applied: false }),
    ]));
  });

  it('preserves ancestor instructions, ordering and deduplication for working and context paths', async () => {
    const cwd = path.join(projectRoot, 'src', 'feature');
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(projectRoot, 'other'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'AGENTS.md'), 'Required source instructions.');
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Required feature instructions.');
    await fs.writeFile(path.join(projectRoot, 'other', 'AGENTS.md'), 'Unrelated instructions.');
    const contextPaths = [path.join(cwd, 'one.ts'), path.join(cwd, 'two.ts'), path.join(projectRoot, '..', 'outside.ts')];

    const runtime = await resolve(cwd, contextPaths);
    const inventory = await resolveInstructionStack({ workingDirectory: cwd, contextPaths, trustGate });
    expect(runtime.mergedContent).toBe(inventory.mergedContent);
    expect(runtime.sources.filter(source => source.applied && source.kind === 'agents').map(source => source.path))
      .toEqual([path.join(projectRoot, 'AGENTS.md'), path.join(projectRoot, 'src', 'AGENTS.md'), path.join(cwd, 'AGENTS.md')]);
    expect(runtime.mergedContent).toContain('Required feature instructions.');
    expect(runtime.mergedContent).not.toContain('Unrelated instructions.');
  });

  it('loads matching Copilot rules when context paths are supplied without walking the rest of the repository', async () => {
    const rulesDir = path.join(projectRoot, '.github', 'instructions', 'nested');
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.mkdir(path.join(projectRoot, 'src', 'app'), { recursive: true });
    await fs.writeFile(path.join(rulesDir, 'typescript.instructions.md'), '---\napplyTo: "src/**/*.ts"\n---\nRequired TypeScript rules.');
    await fs.writeFile(path.join(rulesDir, 'python.instructions.md'), '---\napplyTo: "**/*.py"\n---\nUnrelated Python rules.');
    const contextPaths = [path.join(projectRoot, 'src', 'app', 'example.ts')];

    const runtime = await resolve(projectRoot, contextPaths);
    expect(runtime.mergedContent).toContain('Required TypeScript rules.');
    expect(runtime.mergedContent).not.toContain('Unrelated Python rules.');
    const visited = vi.mocked(fs.readdir).mock.calls.map(call => String(call[0]));
    expect(visited).toEqual([
      projectRoot, path.join(projectRoot, 'src'), path.join(projectRoot, 'src', 'app'),
      path.dirname(rulesDir), rulesDir,
    ]);
    const inventory = await resolveInstructionStack({ workingDirectory: projectRoot, contextPaths, trustGate });
    expect(runtime.mergedContent).toBe(inventory.mergedContent);
  });

  it('preserves excluded-directory and symlink boundaries while loading allowed ancestors', async () => {
    const sourceDir = path.join(projectRoot, 'src');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'AGENTS.md'), 'Allowed ancestor.');
    const generated = path.join(sourceDir, 'node_modules', 'generated');
    await fs.mkdir(generated, { recursive: true });
    await fs.writeFile(path.join(generated, 'AGENTS.md'), 'Excluded instructions.');
    const symlinkTarget = path.join(projectRoot, 'target');
    await fs.mkdir(symlinkTarget, { recursive: true });
    await fs.writeFile(path.join(symlinkTarget, 'AGENTS.md'), 'Symlinked directory instructions.');
    const link = path.join(projectRoot, 'linked');
    await fs.symlink(symlinkTarget, link, 'dir');
    const fileLinkDir = path.join(projectRoot, 'file-link');
    await fs.mkdir(fileLinkDir);
    await fs.symlink(path.join(symlinkTarget, 'AGENTS.md'), path.join(fileLinkDir, 'AGENTS.md'));
    const contextPaths = [path.join(link, 'example.ts'), path.join(fileLinkDir, 'example.ts')];

    const runtime = await resolve(generated, contextPaths);
    const inventory = await resolveInstructionStack({ workingDirectory: generated, contextPaths, trustGate });
    expect(runtime.mergedContent).toBe(inventory.mergedContent);
    expect(runtime.mergedContent).toContain('Allowed ancestor.');
    expect(runtime.mergedContent).not.toContain('Excluded instructions.');
    expect(runtime.mergedContent).not.toContain('Symlinked directory instructions.');
  });

  it('still enforces trust on scoped instructions instead of bypassing the instruction gate', async () => {
    const cwd = path.join(projectRoot, 'src');
    await fs.mkdir(cwd);
    const scopedPath = path.join(cwd, 'AGENTS.md');
    await fs.writeFile(scopedPath, 'Unapproved scoped instructions.');
    const gate = {
      mode: 'enforce',
      evaluate: (filePath: string) => filePath === scopedPath ? 'unknown' : 'approved',
    } satisfies InstructionTrustGate;
    const runtime = await resolveInstructionStack({ workingDirectory: cwd, discovery: 'applicable', trustGate: gate });
    const inventory = await resolveInstructionStack({ workingDirectory: cwd, trustGate: gate });
    expect(runtime.mergedContent).toBe(inventory.mergedContent);
    expect(runtime.mergedContent).not.toContain('Unapproved scoped instructions.');
    expect(runtime.sources.find(source => source.path === scopedPath)).toMatchObject({
      loaded: true, applied: false, trust: 'unknown', reason: expect.stringContaining('has not been approved'),
    });
  });

  it('preserves inventory readability rules for execute-only ancestor directories', async () => {
    const sourceDir = path.join(projectRoot, 'src');
    await fs.mkdir(sourceDir);
    await fs.writeFile(path.join(sourceDir, 'AGENTS.md'), 'Scoped instructions.');
    await fs.chmod(sourceDir, 0o111);
    try {
      const contextPaths = [path.join(sourceDir, 'file.ts')];
      const runtime = await resolve(projectRoot, contextPaths);
      const inventory = await resolveInstructionStack({ workingDirectory: projectRoot, contextPaths, trustGate });
      expect(runtime.mergedContent).toBe(inventory.mergedContent);
      expect(runtime.sources.filter(source => source.scope === 'path-specific'))
        .toEqual(inventory.sources.filter(source => source.scope === 'path-specific'));
    } finally {
      await fs.chmod(sourceDir, 0o700);
    }
  });

  it('uses the actual instruction filename casing on case-insensitive filesystems too', async () => {
    const sourceDir = path.join(projectRoot, 'src');
    await fs.mkdir(sourceDir);
    await fs.writeFile(path.join(sourceDir, 'agents.md'), 'Lowercase instructions.');
    const contextPaths = [path.join(sourceDir, 'file.ts')];
    const runtime = await resolve(projectRoot, contextPaths);
    const inventory = await resolveInstructionStack({ workingDirectory: projectRoot, contextPaths, trustGate });
    expect(runtime.mergedContent).toBe(inventory.mergedContent);
    expect(runtime.mergedContent).not.toContain('Lowercase instructions.');
  });

  it('keeps broad roots from discovering nested instructions in runtime mode', async () => {
    // Treat the throwaway root as home; no actual home directory is scanned.
    vi.mocked(os.homedir).mockReturnValue(projectRoot);
    const cwd = path.join(projectRoot, 'nested');
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Nested home instructions.');
    const runtime = await resolve(cwd);
    expect(runtime.mergedContent).toContain('Required project instructions.');
    expect(runtime.mergedContent).not.toContain('Nested home instructions.');
    expect(fs.readdir).not.toHaveBeenCalled();
  });
});
