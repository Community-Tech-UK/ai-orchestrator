import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SkillLoader } from './skill-loader';
import { SkillRegistry, _resetSkillRegistryForTesting } from './skill-registry';

describe('SkillLoader.discoverSkills (Task 12 spec compliance)', () => {
  let root: string;

  beforeEach(async () => {
    SkillLoader._resetForTesting();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-loader-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    SkillLoader._resetForTesting();
  });

  async function writeSkill(name: string, skillMd: string, extra?: Record<string, string>): Promise<string> {
    const dir = path.join(root, name);
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), skillMd);
    for (const [rel, content] of Object.entries(extra ?? {})) {
      const full = path.join(dir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
    return dir;
  }

  it('parses a real-YAML frontmatter with a colon-bearing quoted description', async () => {
    await writeSkill(
      'demo-skill',
      '---\nname: demo-skill\ndescription: "Use when X: do Y and Z"\ntriggers:\n  - alpha\n  - beta\n---\n# body\n',
    );

    const bundles = await SkillLoader.getInstance().discoverSkills([root]);
    const bundle = bundles.find((b) => b.metadata.name === 'demo-skill');
    expect(bundle).toBeDefined();
    expect(bundle?.metadata.description).toBe('Use when X: do Y and Z');
    expect(bundle?.metadata.triggers).toEqual(['alpha', 'beta']);
  });

  it('skips a skill whose frontmatter name is invalid, without failing the whole load', async () => {
    await writeSkill('good', '---\nname: good\ndescription: fine\n---\n');
    // Uppercase name is invalid per validateSkillName.
    await writeSkill('bad', '---\nname: BadName\ndescription: nope\n---\n');

    const bundles = await SkillLoader.getInstance().discoverSkills([root]);
    const names = bundles.map((b) => b.metadata.name);
    expect(names).toContain('good');
    expect(names).not.toContain('BadName');
  });

  it('excludes reference files matched by a .skillignore', async () => {
    await writeSkill(
      'ignore-demo',
      '---\nname: ignore-demo\ndescription: has ignores\n---\n',
      {
        '.skillignore': '*.png\n',
        'references/keep.md': '# keep',
        'references/shot.png': 'binary-ish',
      },
    );

    const bundles = await SkillLoader.getInstance().discoverSkills([root]);
    const bundle = bundles.find((b) => b.metadata.name === 'ignore-demo');
    expect(bundle).toBeDefined();
    const refNames = bundle!.referencePaths.map((p) => path.basename(p));
    expect(refNames).toContain('keep.md');
    expect(refNames).not.toContain('shot.png');
  });

  it('remains backward-compatible with simple unquoted frontmatter', async () => {
    await writeSkill('legacy', '---\nname: legacy\ndescription: plain text no colon\nversion: 2.0.0\n---\n');

    const bundles = await SkillLoader.getInstance().discoverSkills([root]);
    const bundle = bundles.find((b) => b.metadata.name === 'legacy');
    expect(bundle?.metadata.description).toBe('plain text no colon');
    expect(bundle?.metadata.version).toBe('2.0.0');
  });
});

describe('SkillRegistry.discoverSkills (Task 12 spec compliance)', () => {
  let root: string;

  beforeEach(async () => {
    _resetSkillRegistryForTesting();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-registry-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    _resetSkillRegistryForTesting();
  });

  it('parses colon-bearing YAML and honors .skillignore via the registry path', async () => {
    const dir = path.join(root, 'registry-demo');
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      '---\nname: registry-demo\ndescription: "When X: do Y"\ntriggers:\n  - go\n---\n',
    );
    await fs.writeFile(path.join(dir, '.skillignore'), '*.png\n');
    await fs.writeFile(path.join(dir, 'references/keep.md'), '# keep');
    await fs.writeFile(path.join(dir, 'references/skip.png'), 'png');

    const skills = await SkillRegistry.getInstance().discoverSkills([root]);
    const bundle = skills.find((s) => s.metadata.name === 'registry-demo');
    expect(bundle?.metadata.description).toBe('When X: do Y');
    expect(bundle?.referencePaths.map((p) => path.basename(p))).toEqual(['keep.md']);
  });

  it('skips invalid names without failing discovery of sibling skills', async () => {
    const good = path.join(root, 'good');
    const bad = path.join(root, 'bad');
    for (const dir of [good, bad]) {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(path.join(good, 'SKILL.md'), '---\nname: good\ndescription: ok\ntriggers:\n  - go\n---\n');
    await fs.writeFile(path.join(bad, 'SKILL.md'), '---\nname: BadName\ndescription: nope\ntriggers:\n  - go\n---\n');

    const skills = await SkillRegistry.getInstance().discoverSkills([root]);
    expect(skills.map((s) => s.metadata.name)).toContain('good');
    expect(skills.map((s) => s.metadata.name)).not.toContain('BadName');
  });
});
