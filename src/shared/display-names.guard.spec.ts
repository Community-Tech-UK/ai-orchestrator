/**
 * Guard for step 4 of the Oct-2 calm-screen plan: one name for each thing.
 *
 * Provider names live in `display-names.ts` (`providerName`, `providerToolName`,
 * `accountFamilyName`). Before it, the same provider was spelled four ways in
 * about 17 local maps. This spec reads the production source and fails on:
 *
 *  1. a local map of provider display names (object, switch, option list or
 *     ternary chain), found by `scripts/test-utils/provider-name-maps.ts`;
 *  2. a provider's tool or product name typed out by hand ("Claude Code",
 *     "OpenAI Codex CLI", "Cursor CLI", "OpenCode", "MiMo", ...).
 *
 * There is no baseline and nothing is skipped: zero of each is allowed. The only
 * file that may spell the tool names is the shared module itself, and the last
 * test proves that exemption is that module's real contents rather than a hole.
 *
 * Scope note: rule 2 covers `src` and `packages`. The phone app cannot import
 * `src/shared` at run time, so its handful of provider words are checked against
 * `providerName()` by `apps/mobile/src/app/core/phone-status-parity.spec.ts`.
 * Rule 1 does read `apps/mobile/src` too.
 */

import { describe, expect, it } from 'vitest';
import {
  listProductionSources,
  parseSource,
  readSource,
} from '../../scripts/test-utils/source-scan';
import {
  PROVIDER_IDS,
  TOOL_NAME_LITERALS,
  findHandWrittenToolNames,
  findLocalProviderMaps,
} from '../../scripts/test-utils/provider-name-maps';
import { providerName, providerToolName } from './display-names';

/** The one file that defines the names, so it is the one file allowed to contain them. */
const NAME_MODULE = 'src/shared/display-names.ts';

// The tree is walked, read and parsed once per file run, not once per scan: the
// scans only read what these caches hold, and every scan still sees every file.
const listedRoots = new Map<string, string[]>();
const texts = new Map<string, string>();
const trees = new Map<string, ReturnType<typeof parseSource>>();

function sourcesUnder(roots: readonly string[]): string[] {
  return roots.flatMap((root) => {
    let listed = listedRoots.get(root);
    if (!listed) {
      listed = listProductionSources([root]);
      listedRoots.set(root, listed);
    }
    return listed;
  });
}

function textOf(path: string): string {
  let text = texts.get(path);
  if (text === undefined) {
    text = readSource(path);
    texts.set(path, text);
  }
  return text;
}

function treeOf(path: string): ReturnType<typeof parseSource> {
  let tree = trees.get(path);
  if (!tree) {
    tree = parseSource(path, textOf(path));
    trees.set(path, tree);
  }
  return tree;
}

function scanForMaps(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const path of sourcesUnder(['src', 'packages', 'apps/mobile/src'])) {
    const text = textOf(path);
    // Cheap pre-filter: a map names at least two providers.
    if ([...PROVIDER_IDS].filter((id) => text.includes(id)).length < 2) continue;
    const hits = findLocalProviderMaps(treeOf(path));
    if (hits.length > 0) found.set(path, hits.map((hit) => hit.line));
  }
  return found;
}

function scanForToolNames(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of sourcesUnder(['src', 'packages'])) {
    if (path === NAME_MODULE) continue;
    const text = textOf(path);
    if (![...TOOL_NAME_LITERALS].some((name) => text.includes(name))) continue;
    const hits = findHandWrittenToolNames(treeOf(path));
    if (hits.length > 0) found.set(path, hits.map((hit) => `${hit.line}:${JSON.stringify(hit.text)}`));
  }
  return found;
}

describe('display-names guard: nothing writes provider names by hand', () => {
  it('reads the whole source tree, so a silent scan of nothing cannot pass', () => {
    expect(sourcesUnder(['src']).length).toBeGreaterThan(1500);
    expect(sourcesUnder(['apps/mobile/src']).length).toBeGreaterThan(50);
  });

  it('has no local map of provider display names anywhere (zero allowed)', () => {
    const offenders = [...scanForMaps()].map(([path, lines]) =>
      `${path}:${lines.join(',')}. Use providerName(), providerToolName() or accountFamilyName() from src/shared/display-names.ts.`);
    expect(offenders).toEqual([]);
  });

  it('has no tool or product name typed out by hand outside the name module (zero allowed)', () => {
    const offenders = [...scanForToolNames()].map(([path, hits]) =>
      `${path}: ${hits.join(' ')}. Ask providerToolName() / providerName() / accountFamilyName().`);
    expect(offenders).toEqual([]);
  });

  it('proves the exemption is the real home of the names', () => {
    const source = readSource(NAME_MODULE);
    for (const id of ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode', 'ollama']) {
      expect(source, `${NAME_MODULE} must hold the name of ${id}`).toContain(`'${providerToolName(id)}'`);
      expect(source, `${NAME_MODULE} must hold the name of ${id}`).toContain(`'${providerName(id)}'`);
    }
    expect(source).toContain("'MiMo via OpenCode'");
    // And the exemption is a single file, not a folder.
    expect(sourcesUnder(['src']).filter((path) => path === NAME_MODULE)).toEqual([NAME_MODULE]);
  });
});

describe('findLocalProviderMaps (the detector itself)', () => {
  const scan = (source: string) => findLocalProviderMaps(parseSource('sample.ts', source));

  it('finds an object map, a switch, an array of options and a ternary chain', () => {
    expect(scan(`const a = { claude: 'Claude', codex: 'OpenAI Codex CLI' };`).map((h) => h.kind)).toEqual(['object']);
    expect(scan(`function f(p: string) { switch (p) { case 'claude': return 'Claude Code'; case 'codex': return 'Codex'; default: return p; } }`)
      .map((h) => h.kind)).toEqual(['switch']);
    expect(scan(`const o = [{ id: 'claude', label: 'Claude' }, { id: 'cursor', name: 'Cursor CLI' }];`).map((h) => h.kind)).toEqual(['array']);
    expect(scan(`const n = p === 'claude' ? 'Claude' : p === 'codex' ? 'Codex' : 'Other';`).map((h) => h.kind)).toEqual(['chain']);
  });

  it('sees through "as const" object returns in a switch', () => {
    expect(scan(`function v(p: string) { switch (p) { case 'claude': return { icon: 'a', label: 'Claude' } as const; case 'codex': return { icon: 'b', label: 'Codex' } as const; default: return null; } }`)
      .map((h) => h.kind)).toEqual(['switch']);
  });

  it('ignores things that are not provider names', () => {
    expect(scan(`const colours = { claude: '#D97706', codex: '#10A37F' };`)).toEqual([]);
    expect(scan(`const models = { claude: 'sonnet', codex: 'gpt-5.5' };`)).toEqual([]);
    expect(scan(`const one = { claude: 'Claude' };`)).toEqual([]);
    expect(scan(`const files = { claude: 'Claude user config', codex: 'Codex settings file' };`)).toEqual([]);
    expect(scan(`const call = providerName('claude');`)).toEqual([]);
    expect(scan(`const labels = { claude: providerName('claude'), codex: providerName('codex') };`)).toEqual([]);
  });
});

describe('findHandWrittenToolNames (the second detector)', () => {
  const scan = (source: string) => findHandWrittenToolNames(parseSource('sample.ts', source)).map((hit) => hit.text);

  it('finds a tool name typed in any position that reaches the screen', () => {
    expect(scan(`const a = { displayName: 'Claude Code' };`)).toEqual(['Claude Code']);
    expect(scan(`const b = ['OpenAI Codex CLI', 'Cursor CLI'];`)).toEqual(['OpenAI Codex CLI', 'Cursor CLI']);
    expect(scan('const c = `OpenCode`;')).toEqual(['OpenCode']);
    expect(scan(`function f() { return 'Grok Build'; }`)).toEqual(['Grok Build']);
    expect(scan(`const d = provider === 'x' ? 'MiMo' : 'Antigravity';`)).toEqual(['MiMo', 'Antigravity']);
  });

  it('leaves sentences, bare family names, module paths and object keys alone', () => {
    expect(scan(`const a = 'Claude Code could not start';`)).toEqual([]);
    expect(scan(`const b = { family: 'Claude', editor: 'Cursor', runtime: 'Ollama' };`)).toEqual([]);
    expect(scan(`import x from 'OpenCode';`)).toEqual([]);
    expect(scan(`const c = { 'OpenCode': 1 };`)).toEqual([]);
    expect(scan(`const d = providerToolName('claude');`)).toEqual([]);
  });
});
