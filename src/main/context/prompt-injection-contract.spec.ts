import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_PROMPT_BLOCK_ORDER,
  SYSTEM_PROMPT_BLOCK_SEPARATOR,
  createSystemPromptComposer,
  findVolatileText,
} from './prompt-injection-contract';

describe('SYSTEM_PROMPT_BLOCK_ORDER snapshot', () => {
  it('matches the locked contract order (changing this is a cache-busting release event)', () => {
    // A change here means every provider's cached system-prompt prefix goes
    // stale for every existing session the moment it ships. That can be the
    // right call (e.g. a genuinely new injection point), but it must be a
    // deliberate decision made in review, not an incidental refactor. If this
    // assertion fails because you intentionally reordered/added/removed a
    // block kind, update this array AND call it out explicitly in the PR/plan
    // as a cache-busting change.
    expect(SYSTEM_PROMPT_BLOCK_ORDER).toEqual([
      'instructions',
      'output-style',
      'observation-memory',
      'project-brief',
      'lessons',
      'repo-map',
      'wake-context',
      'mcp-tool-context',
      'tool-permissions',
    ]);
  });
});

describe('createSystemPromptComposer', () => {
  it('joins added blocks with the exact separator used across the codebase', () => {
    const composer = createSystemPromptComposer();
    composer.add('instructions', 'base instructions');
    composer.add('lessons', 'learned lesson text');
    composer.add('tool-permissions', 'tool permission text');

    const { text } = composer.compose();
    expect(text).toBe(
      `base instructions${SYSTEM_PROMPT_BLOCK_SEPARATOR}learned lesson text${SYSTEM_PROMPT_BLOCK_SEPARATOR}tool permission text`,
    );
  });

  it('puts the instructions block first with no leading separator', () => {
    const composer = createSystemPromptComposer();
    composer.add('instructions', 'only block');
    expect(composer.compose().text).toBe('only block');
  });

  it('skips blocks with empty, null, or undefined content without leaving stray separators', () => {
    const composer = createSystemPromptComposer();
    composer.add('instructions', '');
    composer.add('output-style', undefined);
    composer.add('observation-memory', null);
    composer.add('project-brief', 'brief text');
    composer.add('lessons', undefined);
    composer.add('tool-permissions', 'perms');

    expect(composer.compose().text).toBe(`brief text${SYSTEM_PROMPT_BLOCK_SEPARATOR}perms`);
  });

  it('throws on an out-of-order add (a kind added before an earlier kind already added)', () => {
    const composer = createSystemPromptComposer();
    composer.add('lessons', 'lessons text');
    expect(() => composer.add('output-style', 'style text')).toThrow(/out of order/);
  });

  it('throws on a duplicate add for the same kind', () => {
    const composer = createSystemPromptComposer();
    composer.add('instructions', 'first');
    expect(() => composer.add('instructions', 'second')).toThrow(/duplicate/i);
  });

  it('throws on an unknown block kind', () => {
    const composer = createSystemPromptComposer();
    // @ts-expect-error -- deliberately passing an invalid kind to test the runtime guard.
    expect(() => composer.add('not-a-real-kind', 'x')).toThrow(/unknown/i);
  });

  it('allows skipping ahead in the order (a middle kind never added at all)', () => {
    const composer = createSystemPromptComposer();
    composer.add('instructions', 'a');
    // 'output-style', 'observation-memory', 'project-brief' all skipped.
    composer.add('lessons', 'b');
    expect(composer.compose().text).toBe(`a${SYSTEM_PROMPT_BLOCK_SEPARATOR}b`);
  });

  it('produces a manifest with stable content hashes, char lengths, and positions', () => {
    const build = () => {
      const composer = createSystemPromptComposer();
      composer.add('instructions', 'alpha');
      composer.add('repo-map', 'beta content');
      composer.add('tool-permissions', 'gamma');
      return composer.compose();
    };

    const first = build();
    const second = build();

    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifest).toEqual([
      { kind: 'instructions', contentHash: sha256('alpha'), charLength: 5, position: 0 },
      { kind: 'repo-map', contentHash: sha256('beta content'), charLength: 12, position: 1 },
      { kind: 'tool-permissions', contentHash: sha256('gamma'), charLength: 5, position: 2 },
    ]);
  });

  it('assembles a representative full prompt byte-identically across two composers with identical inputs', () => {
    const buildFullPrompt = () => {
      const composer = createSystemPromptComposer();
      composer.add('instructions', 'You are a helpful coding agent.');
      composer.add('output-style', 'Output style — Concise: minimize prose.');
      composer.add('observation-memory', 'Past reflection: prefer const bindings.');
      composer.add('project-brief', 'Project: ai-orchestrator. Electron + Angular.');
      composer.add('lessons', '## Lessons\n- Always run tsc --noEmit.');
      composer.add('repo-map', 'src/main/, src/renderer/, src/shared/');
      composer.add('wake-context', 'AI orchestrator assistant.\n\n## L1 — ESSENTIAL STORY');
      composer.add('mcp-tool-context', '[MCP] 3 tools selected.');
      composer.add('tool-permissions', '[Tool Permissions] Tools follow the current tool policy.');
      return composer.compose();
    };

    const first = buildFullPrompt();
    const second = buildFullPrompt();

    expect(second.text).toBe(first.text);
    expect(second.manifest).toEqual(first.manifest);
  });
});

describe('findVolatileText', () => {
  it('flags a seeded ISO-8601 timestamp', () => {
    const findings = findVolatileText('Session started at 2026-07-30T12:00:00.000Z for review.');
    expect(findings.some((f) => f.kind === 'iso-timestamp' && f.match === '2026-07-30T12:00:00.000Z')).toBe(true);
  });

  it('flags a seeded epoch-millisecond number in the plausible 2020-2040 range', () => {
    // 2026-07-30T00:00:00Z in epoch milliseconds.
    const findings = findVolatileText('generated 1785283200000 build id');
    expect(findings.some((f) => f.kind === 'epoch-millis' && f.match === '1785283200000')).toBe(true);
  });

  it('does not flag a 13-digit number outside the plausible epoch-ms range', () => {
    const findings = findVolatileText('serial number 9999999999999 assigned');
    expect(findings.some((f) => f.kind === 'epoch-millis')).toBe(false);
  });

  it('flags a seeded UUID', () => {
    const findings = findVolatileText('trace id 550e8400-e29b-41d4-a716-446655440000 attached');
    expect(findings.some((f) => f.kind === 'uuid' && f.match === '550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('flags a generatedAt-style key with a numeric value', () => {
    const findings = findVolatileText('{"generatedAt": 1785283200000, "content": "hello"}');
    expect(findings.some((f) => f.kind === 'generated-at-key')).toBe(true);
  });

  it('returns no findings for clean, non-volatile text', () => {
    const findings = findVolatileText(
      'You are a helpful coding agent. Prefer const over let. Do not import zone.js.',
    );
    expect(findings).toEqual([]);
  });
});

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
