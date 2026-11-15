import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
interface Transfer { version: number; files: { path: string; text: string; mtimeMs: number; mode: number; memory: boolean }[]; links: { path: string; target: string }[]; exclusions: string[] }
const { buildSyncPackage, applySyncPackage, filterCodexConfig, renderSyncHook } = require('./sync-agent-setup.js') as {
  buildSyncPackage(options: { sourceHome: string }): Transfer;
  applySyncPackage(pkg: Transfer, options: { destinationHome: string }): { changed: number; exclusions: number; excludedPaths: string[] };
  filterCodexConfig(text: string): string;
  renderSyncHook(text: string, options: { scriptPath: string; remote: string; destinationHome: string }): string;
};
const roots: string[] = [];
function home(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-sync-')); roots.push(dir); return dir; }
function write(root: string, relative: string, text: string): string {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file;
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const { serializeToml, readConfig } = require('./sync-policy') as {
  serializeToml(value: Record<string, unknown>): string;
  readConfig(text: string, kind: string, label: string): Record<string, unknown>;
};
const unsafeCommands = [
  { command: 'osascript -e tell application Google Chrome to activate' },
  { command: '/usr/bin/osascript', args: ['-e', 'tell application Google Chrome to activate'] },
  { command: 'open', args: ['-a', 'Chrome'] },
  { executable: 'python', arguments: ['-c', 'import pyautogui; pyautogui.click()'] },
  { command: 'node', args: ['-e', 'require("playwright").chromium.launch()'] },
  { command: 'cmd.exe', args: ['/c', 'start', 'chrome.exe'] },
];
const safeCommand = { type: 'command', command: 'node', args: ['report.js'] };
const safePrompt = { type: 'prompt', prompt: 'Summarize the output.' };
const safeHooks = { Stop: [{ matcher: '*', hooks: [safeCommand, safePrompt] }] };
function configWithCommands(kind: 'claude' | 'codex', localState = false): Record<string, unknown> {
  const gateway = { command: 'node', args: ['gateway.js'], description: 'chrome-devtools is forbidden; use the Browser Gateway.',
    env: localState ? { EXAMPLE_LOCAL_SECRET: 'EXAMPLE_LOCAL_VALUE' } : { TOOLSETS: 'docs' } };
  const servers = { gateway, ...Object.fromEntries(unsafeCommands.map((command, index) => [`custom_${index}`, command])) };
  return {
    ...(kind === 'codex' ? { notify: ['osascript', '-e', 'tell application Google Chrome to activate'], mcp_servers: servers }
      : { statusLine: { type: 'command', command: unsafeCommands[0].command }, permissions: {
        allow: ['Bash(osascript:*)', 'Bash(open -a:*)', 'mcp__chrome-devtools__*', 'Bash(node:*)'],
        ask: ['Bash(pyautogui:*)', 'Bash(node:*)'], deny: ['Bash(osascript:*)'],
      }, ...(localState ? { mcpServers: servers, oauthAccount: { value: 'EXAMPLE_LOCAL_LOGIN' } } : {}) }),
    hooks: { Stop: [{ matcher: '*', hooks: [...unsafeCommands.map(command => ({ type: 'command', ...command })),
      { type: 'prompt', prompt: 'Use computer.click to continue.' }, safeCommand, safePrompt] }] },
  };
}
function assertCommandsFiltered(value: Record<string, unknown>, kind: 'claude' | 'codex', localState = false): void {
  expect(value).not.toHaveProperty(kind === 'codex' ? 'notify' : 'statusLine');
  expect(value.hooks).toEqual(safeHooks);
  if (kind === 'claude') expect(value.permissions).toEqual({ allow: ['Bash(node:*)'], ask: ['Bash(node:*)'], deny: ['Bash(osascript:*)'] });
  if (kind === 'codex' || localState) expect(value[kind === 'codex' ? 'mcp_servers' : 'mcpServers']).toEqual({ gateway: {
    command: 'node', args: ['gateway.js'], description: 'chrome-devtools is forbidden; use the Browser Gateway.',
    env: localState ? { EXAMPLE_LOCAL_SECRET: 'EXAMPLE_LOCAL_VALUE' } : { TOOLSETS: 'docs' },
  } });
  if (kind === 'claude' && localState) expect(value.oauthAccount).toEqual({ value: 'EXAMPLE_LOCAL_LOGIN' });
}

describe('home-base agent setup sync', () => {
  it('filters every source config command sink and external hook/command before copying', () => {
    const source = home(); const destination = home();
    write(source, '.claude/settings.json', JSON.stringify(configWithCommands('claude')));
    write(source, '.codex/config.toml', serializeToml(configWithCommands('codex')));
    write(source, '.claude/hooks/show-status.sh', '#!/bin/sh\nopen -a Chrome\n');
    write(source, '.claude/commands/show-status.md', '# Open Chrome with osascript\n');
    write(source, '.claude/hooks/report.sh', '#!/bin/sh\nprintf ready\n');
    const pkg = buildSyncPackage({ sourceHome: source });
    expect(pkg.files.map(file => file.path)).not.toContain('.claude/hooks/show-status.sh');
    expect(pkg.files.map(file => file.path)).not.toContain('.claude/commands/show-status.md');
    expect(pkg.files.map(file => file.path)).toContain('.claude/hooks/report.sh');
    applySyncPackage(pkg, { destinationHome: destination });
    assertCommandsFiltered(readConfig(fs.readFileSync(path.join(destination, '.claude/settings.json'), 'utf8'), 'claude', 'fixture'), 'claude');
    assertCommandsFiltered(readConfig(fs.readFileSync(path.join(destination, '.codex/config.toml'), 'utf8'), 'codex', 'fixture'), 'codex');
  });
  it('filters config sinks recursively in default and named homes without losing safe metadata or local credentials', () => {
    const source = home(); const destination = home();
    const configs: { file: string; kind: 'claude' | 'codex' }[] = [
      { file: '.claude.json', kind: 'claude' }, { file: '.claude/settings.json', kind: 'claude' }, { file: '.codex/config.toml', kind: 'codex' },
    ];
    for (const stateRoot of ['.orchestrator', '.ai-orchestrator', 'Library/Application Support/harness']) {
      configs.push({ file: `${stateRoot}/claude-cli-profiles/named/.claude.json`, kind: 'claude' },
        { file: `${stateRoot}/claude-cli-profiles/named/settings.json`, kind: 'claude' }, { file: `${stateRoot}/codex-cli-profiles/named/config.toml`, kind: 'codex' });
    }
    for (const { file, kind } of configs) {
      const value = configWithCommands(kind, true);
      value.projects = { example: configWithCommands(kind, true) };
      write(destination, file, kind === 'codex' ? serializeToml(value) : JSON.stringify(value));
      const base = file.endsWith('.toml') ? path.posix.dirname(file) : file === '.claude.json' ? '.claude' : path.posix.dirname(file);
      write(destination, `${base}/hooks/show-status.sh`, '#!/bin/sh\nopen -a Chrome\n');
      write(destination, `${base}/commands/show-status.md`, '# Use osascript to open Chrome\n');
      write(destination, `${base}/hooks/report.sh`, '#!/bin/sh\nprintf ready\n');
    }
    applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination });
    for (const { file, kind } of configs) {
      const value = readConfig(fs.readFileSync(path.join(destination, file), 'utf8'), kind, 'fixture');
      assertCommandsFiltered(value, kind, true);
      assertCommandsFiltered((value.projects as Record<string, Record<string, unknown>>).example, kind, true);
      const base = file.endsWith('.toml') ? path.posix.dirname(file) : file === '.claude.json' ? '.claude' : path.posix.dirname(file);
      expect(fs.existsSync(path.join(destination, `${base}/hooks/show-status.sh`))).toBe(false);
      expect(fs.existsSync(path.join(destination, `${base}/commands/show-status.md`))).toBe(false);
      expect(fs.readFileSync(path.join(destination, `${base}/hooks/report.sh`), 'utf8')).toContain('printf ready');
    }
  });
  it('preserves harmless status commands, notify argv and gateway-only hooks', () => {
    const source = home(); const destination = home();
    const statusLine = { type: 'command', command: 'node status.js' };
    const notify = ['node', 'report.js'];
    const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['gateway.js', 'browser.snapshot'] }] }] };
    write(source, '.claude/settings.json', JSON.stringify({ statusLine, hooks }));
    write(source, '.codex/config.toml', serializeToml({ notify, hooks }));
    applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination });
    expect(readConfig(fs.readFileSync(path.join(destination, '.claude/settings.json'), 'utf8'), 'claude', 'fixture')).toMatchObject({ statusLine, hooks });
    expect(readConfig(fs.readFileSync(path.join(destination, '.codex/config.toml'), 'utf8'), 'codex', 'fixture')).toMatchObject({ notify, hooks });
  });
  it('copies only approved setup and dereferences skill links without taking logins or direct-browser skills', () => {
    const source = home();
    write(source, '.agents/AGENTS.md', '# Rules');
    write(source, '.agents/skills/custom/SKILL.md', '# Safe custom skill');
    fs.mkdirSync(path.join(source, '.codex/skills'), { recursive: true });
    fs.symlinkSync(path.join(source, '.agents/skills/custom'), path.join(source, '.codex/skills/custom'), 'dir');
    write(source, '.codex/auth.json', 'EXAMPLE_LOGIN');
    write(source, '.claude.json', 'EXAMPLE_LOGIN');
    write(source, '.claude/.credentials.json', 'EXAMPLE_LOGIN');
    write(source, '.agents/skills/playwright/SKILL.md', '# Browser driver');
    const pkg = buildSyncPackage({ sourceHome: source });
    expect(pkg.files.map(file => file.path)).toEqual(expect.arrayContaining(['.agents/AGENTS.md', '.codex/skills/custom/SKILL.md']));
    expect(JSON.stringify(pkg)).not.toContain('EXAMPLE_LOGIN');
    expect(pkg.files.some(file => file.path.includes('playwright'))).toBe(false);
  });
  it('refuses unknown environment values without echoing them', () => {
    const source = home();
    write(source, '.claude/settings.json', JSON.stringify({ env: { UNKNOWN_SETTING: 'EXAMPLE_PRIVATE_VALUE' } }));
    try { buildSyncPackage({ sourceHome: source }); throw new Error('expected refusal'); }
    catch (error) {
      expect(String(error)).toContain('UNKNOWN_SETTING');
      expect(String(error)).not.toContain('EXAMPLE_PRIVATE_VALUE');
    }
  });
  const directSkillInstructions = [
    '# Web testing\nUse chrome-devtools to navigate a local Chrome tab and inspect the page.\n',
    '# Inspect pages with Playwright\n',
    '# Desktop helper\nUse computer.screenshot and computer.click to inspect the desktop.\n',
    '# Desktop helper\nUse pyautogui to click the window.\n',
    '# Web testing\nUse browser automation to inspect the page.\n',
    '# Mac helper\nUse AppleScript to tell System Events to click the window.\n',
    '# App helper\nRun `open -a Chrome` to inspect the page.\n',
    '# Desktop helper\nCall computer.* tools to inspect the window.\n',
  ];
  const gatewaySkill = '# Browser testing\nUse only the AIO Browser Gateway. Use browser.find_or_open then browser.snapshot.\n';
  it.each(['.agents/skills', '.claude/skills', '.codex/skills'])('excludes whole safe-named direct-control skills by instructions from %s', root => {
    const source = home(); const destination = home();
    directSkillInstructions.forEach((text, index) => {
      write(source, `${root}/web-testing-${index}/SKILL.md`, text);
      write(source, `${root}/web-testing-${index}/resources/notes.md`, 'Supporting reference');
    });
    write(source, `${root}/web-testing-reference/SKILL.md`, '# Reports\nRead resources/guide.md.\n');
    write(source, `${root}/web-testing-reference/resources/guide.md`, directSkillInstructions[0]);
    write(source, `${root}/gateway-testing/SKILL.md`, gatewaySkill);
    const pkg = buildSyncPackage({ sourceHome: source });
    expect(pkg.files.map(file => file.path)).toEqual([`${root}/gateway-testing/SKILL.md`]);
    expect(pkg.exclusions).toEqual([...directSkillInstructions.map((_, index) => `${root}/web-testing-${index}`), `${root}/web-testing-reference`]);
    applySyncPackage(pkg, { destinationHome: destination });
    expect(fs.readFileSync(path.join(destination, `${root}/gateway-testing/SKILL.md`), 'utf8')).toBe(gatewaySkill);
    directSkillInstructions.forEach((_, index) => expect(fs.existsSync(path.join(destination, `${root}/web-testing-${index}`))).toBe(false));
  });
  it('removes safe-named direct-control skills from existing default and named Claude/Codex homes', () => {
    const source = home(); const destination = home();
    const skillRoots = ['.agents/skills', '.claude/skills', '.codex/skills'];
    for (const stateRoot of ['.orchestrator', '.ai-orchestrator', 'Library/Application Support/harness']) {
      for (const provider of ['claude', 'codex']) skillRoots.push(`${stateRoot}/${provider}-cli-profiles/named/skills`);
    }
    for (const root of skillRoots) {
      directSkillInstructions.forEach((text, index) => {
        write(destination, `${root}/web-testing-${index}/SKILL.md`, text);
        write(destination, `${root}/web-testing-${index}/resources/notes.md`, 'Supporting reference');
      });
      write(destination, `${root}/gateway-testing/SKILL.md`, gatewaySkill);
    }
    const report = applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination });
    expect(report.exclusions).toBe(skillRoots.length * directSkillInstructions.length);
    expect(report.excludedPaths).toEqual(skillRoots.flatMap(root => directSkillInstructions.map((_, index) => `${root}/web-testing-${index}`)));
    for (const root of skillRoots) {
      directSkillInstructions.forEach((_, index) => expect(fs.existsSync(path.join(destination, `${root}/web-testing-${index}`))).toBe(false));
      expect(fs.readFileSync(path.join(destination, `${root}/gateway-testing/SKILL.md`), 'utf8')).toBe(gatewaySkill);
    }
  });
  it('inspects skill instructions through internal skill and named-home folder links', () => {
    const source = home(); const destination = home();
    const shared = write(destination, 'shared-skills/web-testing/SKILL.md', directSkillInstructions[0]);
    const namedRoot = '.orchestrator/codex-cli-profiles/named';
    fs.mkdirSync(path.join(destination, namedRoot), { recursive: true });
    fs.symlinkSync(path.join(destination, 'shared-skills'), path.join(destination, namedRoot, 'skills'), 'dir');
    fs.mkdirSync(path.join(destination, '.claude/skills'), { recursive: true });
    fs.symlinkSync(path.dirname(shared), path.join(destination, '.claude/skills/alias'), 'dir');
    const report = applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination });
    expect(report.exclusions).toBe(2);
    expect(fs.existsSync(path.join(destination, '.claude/skills/alias'))).toBe(false);
    expect(fs.existsSync(path.join(destination, namedRoot, 'skills/web-testing'))).toBe(false);
  });
  it('rejects an older or altered package containing direct skill instructions before writes', () => {
    const source = home(); const destination = home();
    write(source, '.agents/AGENTS.md', '# Rules');
    write(source, '.agents/skills/web-testing/SKILL.md', '# Safe reports');
    const pkg = buildSyncPackage({ sourceHome: source });
    pkg.files = pkg.files.map(file => file.path.endsWith('SKILL.md') ? { ...file, text: directSkillInstructions[0] } : file);
    expect(() => applySyncPackage(pkg, { destinationHome: destination })).toThrow(/direct browser or desktop skill/);
    expect(fs.existsSync(path.join(destination, '.agents/AGENTS.md'))).toBe(false);
  });
  it('refuses cyclic skill links before changing destination rules', () => {
    const source = home(); const destination = home();
    write(source, '.agents/AGENTS.md', '# Rules');
    write(destination, '.claude/skills/reports/SKILL.md', '# Safe reports');
    fs.symlinkSync(path.join(destination, '.claude/skills/reports'), path.join(destination, '.claude/skills/reports/loop'), 'dir');
    expect(() => applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination })).toThrow(/cyclic setup link/);
    expect(fs.existsSync(path.join(destination, '.agents/AGENTS.md'))).toBe(false);
  });
  it('preserves schema and table resource bytes while retaining binary asset refusals', () => {
    const source = home(); const destination = home();
    const resources = {
      'schema.xsd': '<?xml version="1.0"?>\r\n<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">\r\n  <xs:element name="café" type="xs:string"/>\r\n</xs:schema>\r\n',
      'document.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<document><title>Résumé &amp; notes</title></document>\n',
      'table.csv': 'name,notes\r\n"Café","first, second"\r\n"Example","two\nlines"\r\n',
    };
    for (const [name, text] of Object.entries(resources)) write(source, `.agents/skills/documents/resources/${name}`, text);
    const pkg = buildSyncPackage({ sourceHome: source });
    expect(pkg.files).toHaveLength(3);
    applySyncPackage(pkg, { destinationHome: destination });
    for (const name of Object.keys(resources)) {
      const relative = `.agents/skills/documents/resources/${name}`;
      expect(fs.readFileSync(path.join(destination, relative))).toEqual(fs.readFileSync(path.join(source, relative)));
    }
    for (const name of ['image.png', 'font.woff2']) {
      const file = write(source, `.agents/skills/documents/resources/${name}`, 'EXAMPLE_BINARY_ASSET');
      expect(() => buildSyncPackage({ sourceHome: source })).toThrow(/non-text asset requires separate review/);
      fs.unlinkSync(file);
    }
  });
  it('removes direct drivers, preserves known safe plugins and refuses unclassified bundled plugins', () => {
    const next = filterCodexConfig(`model = "example-model"\n[mcp_servers.playwright]\ncommand = "driver"\n[mcp_servers.safe]\ncommand = "safe-server"\n[plugins."chrome@openai-bundled"]\nenabled = true\n[plugins."visualize@openai-bundled"]\nenabled = true\n`);
    expect(next).not.toContain('mcp_servers.playwright');
    expect(next).toContain('safe-server');
    expect(next).toContain('"chrome@openai-bundled"');
    expect(next).toContain('"visualize@openai-bundled"');
    expect(() => filterCodexConfig('[plugins."unknown@openai-bundled"]\nenabled = true\n')).toThrow(/unclassified/);
    const parser = require('toml-eslint-parser') as { parseTOML(text: string): unknown; getStaticTOMLValue(ast: unknown): { plugins: Record<string, { enabled: boolean }> } };
    const parsed = parser.getStaticTOMLValue(parser.parseTOML(next));
    expect(parsed.plugins['chrome@openai-bundled'].enabled).toBe(false);
    expect(parsed.plugins['visualize@openai-bundled'].enabled).toBe(true);
  });
  it('filters existing default and named account configs while preserving their local sign-in state', () => {
    const source = home(); const destination = home();
    write(source, '.agents/AGENTS.md', '# Rules');
    const claude = { oauthAccount: { value: 'EXAMPLE_LOCAL_LOGIN' }, mcpServers: { 'chrome-devtools': { command: 'driver' }, safe: { command: 'safe' } }, projects: { example: { mcpServers: { 'node_repl': { command: 'driver' } } } } };
    const profile = '.orchestrator/claude-cli-profiles/named/.claude.json';
    write(destination, '.claude.json', JSON.stringify(claude));
    write(destination, profile, JSON.stringify(claude));
    write(destination, '.codex/config.toml', '[mcp_servers.playwright]\ncommand = "driver"\n');
    const codexProfile = '.orchestrator/codex-cli-profiles/named/';
    write(destination, codexProfile + 'config.toml', '[mcp_servers.playwright]\ncommand = "driver"\n');
    write(destination, codexProfile + 'skills/playwright/SKILL.md', '# Direct browser driver');
    applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination });
    for (const file of ['.claude.json', profile]) {
      const result = JSON.parse(fs.readFileSync(path.join(destination, file), 'utf8'));
      expect(result.oauthAccount.value).toBe('EXAMPLE_LOCAL_LOGIN');
      expect(result.mcpServers).toEqual({ safe: { command: 'safe' } });
      expect(result.projects.example.mcpServers).toEqual({});
    }
    expect(fs.readFileSync(path.join(destination, '.codex/config.toml'), 'utf8')).not.toContain('driver');
    expect(fs.readFileSync(path.join(destination, codexProfile + 'config.toml'), 'utf8')).not.toContain('driver');
    expect(fs.existsSync(path.join(destination, codexProfile + 'skills/playwright'))).toBe(false);
  });
  it('keeps newer remote memory and remote-only files, merging MEMORY.md by distinct lines', () => {
    const source = home(); const destination = home();
    const stem = '.claude/projects/example/memory/';
    write(source, stem + 'MEMORY.md', 'shared\nsource\n');
    write(destination, stem + 'MEMORY.md', 'shared\ndestination\n');
    write(source, stem + 'detail.md', 'old');
    const remote = write(destination, stem + 'detail.md', 'new');
    fs.utimesSync(remote, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    write(destination, stem + 'remote-only.md', 'keep');
    applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination });
    expect(fs.readFileSync(remote, 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(destination, stem + 'MEMORY.md'), 'utf8')).toBe('shared\ndestination\nsource\n');
    expect(fs.existsSync(path.join(destination, stem + 'remote-only.md'))).toBe(true);
  });
  it('refuses destination symlink escapes before changing any setup file', () => {
    const source = home(); const destination = home(); const outside = home();
    write(source, '.agents/AGENTS.md', '# New');
    fs.symlinkSync(outside, path.join(destination, '.agents'), 'dir');
    expect(() => applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination })).toThrow(/symlink|outside/);
    expect(fs.existsSync(path.join(outside, 'AGENTS.md'))).toBe(false);
  });
  it('ignores non-directory project metadata and rejects malformed transfer reports before writes', () => {
    const source = home(); const destination = home();
    write(source, '.claude/projects/.DS_Store', 'metadata');
    write(source, '.agents/AGENTS.md', '# New');
    const pkg = buildSyncPackage({ sourceHome: source });
    expect(() => applySyncPackage({ ...pkg, exclusions: undefined } as unknown as Transfer, { destinationHome: destination })).toThrow(/Invalid/);
    expect(fs.existsSync(path.join(destination, '.agents/AGENTS.md'))).toBe(false);
  });
  it.each(['Authorization: Bearer do-not-copy-this-literal', 'command --token do-not-copy-this-literal', 'command --password=do-not-copy-this-literal'])('refuses literal credentials in setup prose or commands', line => {
    const source = home(); write(source, '.agents/AGENTS.md', line);
    expect(() => buildSyncPackage({ sourceHome: source })).toThrow(/credential/);
  });
  it('keeps destination-only environment credentials and shared settings links', () => {
    const source = home(); const destination = home();
    write(source, '.claude/settings.json', JSON.stringify({ alwaysThinkingEnabled: true }));
    const canonical = write(destination, '.claude/settings.json', JSON.stringify({ env: { EXAMPLE_LOCAL_SECRET: 'EXAMPLE_LOCAL_VALUE' } }));
    const profile = '.orchestrator/claude-cli-profiles/named/settings.json';
    fs.mkdirSync(path.dirname(path.join(destination, profile)), { recursive: true });
    fs.symlinkSync(canonical, path.join(destination, profile));
    applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination });
    expect(fs.lstatSync(path.join(destination, profile)).isSymbolicLink()).toBe(true);
    const result = JSON.parse(fs.readFileSync(canonical, 'utf8'));
    expect(result.env.EXAMPLE_LOCAL_SECRET).toBe('EXAMPLE_LOCAL_VALUE');
    expect(result.alwaysThinkingEnabled).toBe(true);
  });
  it('reports an absent approved environment path instead of copying a broken configuration', () => {
    const source = home(); const destination = home();
    write(source, '.claude/settings.json', JSON.stringify({ env: { CCLSP_CONFIG_PATH: path.join(source, 'not-provisioned.json') } }));
    expect(() => applySyncPackage(buildSyncPackage({ sourceHome: source }), { destinationHome: destination })).toThrow(/CCLSP_CONFIG_PATH/);
    expect(fs.existsSync(path.join(destination, '.claude/settings.json'))).toBe(false);
  });
  it('adds one safely quoted integration block without changing the existing local sync', () => {
    const original = '#!/bin/zsh\nset -eu\nprint local\n';
    const options = { scriptPath: "/Users/example/O'Brien/sync-agent-setup.js", remote: 'ct-test-mac', destinationHome: '/Users/example' };
    const once = renderSyncHook(original, options);
    expect(renderSyncHook(once, options)).toBe(once);
    expect(once.startsWith(original)).toBe(true);
    expect(once).toContain("O'\\''Brien");
    expect(() => renderSyncHook(original, { ...options, remote: '-oProxyCommand=anything' })).toThrow();
  });
});
