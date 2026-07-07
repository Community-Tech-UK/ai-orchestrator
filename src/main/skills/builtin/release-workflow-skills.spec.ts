import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillRegistry, _resetSkillRegistryForTesting } from '../skill-registry';

const builtinSkillDir = join(process.cwd(), 'src/main/skills/builtin');

const RELEASE_SKILLS = [
  'ios-release',
  'android-release',
  'new-app-setup',
];

describe('built-in release workflow skills', () => {
  afterEach(() => {
    _resetSkillRegistryForTesting();
  });

  it('discovers release workflow skills through built-in registry discovery', async () => {
    _resetSkillRegistryForTesting();
    const registry = SkillRegistry.getInstance();
    const skills = await registry.discoverSkillsWithBuiltins([]);
    const discoveredNames = new Set(skills.map((skill) => skill.metadata.name));

    for (const skillName of RELEASE_SKILLS) {
      expect(discoveredNames.has(skillName), `${skillName} discovered`).toBe(true);
    }

    expect(registry.matchTrigger('/ios-release binsout internal')[0]?.skill.metadata.name)
      .toBe('ios-release');
    expect(registry.matchTrigger('/android-release binsout internal')[0]?.skill.metadata.name)
      .toBe('android-release');
    expect(registry.matchTrigger('/new-app-setup play console')[0]?.skill.metadata.name)
      .toBe('new-app-setup');
  });

  it.each(RELEASE_SKILLS)('%s declares valid release-skill frontmatter', (skillName) => {
    const content = readFileSync(join(builtinSkillDir, skillName, 'SKILL.md'), 'utf8');
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);

    expect(frontmatter, `${skillName} frontmatter`).not.toBeNull();
    const block = frontmatter![1];
    expect(block, `${skillName} name`).toMatch(/^name:\s*\S/m);
    expect(block, `${skillName} description`).toMatch(/^description:\s*\S/m);
    expect(block, `${skillName} triggers array`).toMatch(/^triggers:\s*\[/m);
    expect(block, `${skillName} category`).toMatch(/^category:\s*release$/m);
  });

  it('captures executable iOS release gotchas', () => {
    const content = readFileSync(join(builtinSkillDir, 'ios-release', 'SKILL.md'), 'utf8');

    expect(content).toContain('CURRENT_PROJECT_VERSION');
    expect(content).toContain('xcrun altool');
    expect(content).toContain('~/.appstoreconnect/private_keys/AuthKey_');
    expect(content).toContain('usesNonExemptEncryption');
    expect(content).toContain('TestFlight');
    expect(content).toContain('ASC API');
  });

  it('captures executable Android release gotchas', () => {
    const content = readFileSync(join(builtinSkillDir, 'android-release', 'SKILL.md'), 'utf8');

    expect(content).toContain('versionCode');
    expect(content).toContain('upload.keystore.properties');
    expect(content).toContain('bundleRelease');
    expect(content).toContain('Play Developer Publishing API');
    expect(content).toContain('Add from library');
    expect(content).toContain('assetlinks.json');
  });

  it('captures checkpointed browser setup conventions for console-only release work', () => {
    const content = readFileSync(join(builtinSkillDir, 'new-app-setup', 'SKILL.md'), 'utf8');

    expect(content).toContain('browser.claim_campaign_lease');
    expect(content).toContain('browser.check_session');
    expect(content).toContain('browser.raise_escalation');
    expect(content).toContain('checkpoint');
    expect(content).toContain('Content rating');
    expect(content).toContain('Data safety');
    expect(content).toContain('privacy nutrition labels');
  });
});
