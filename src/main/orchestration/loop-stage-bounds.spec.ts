import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopStageMachine } from './loop-stage-machine';
import { defaultLoopConfig } from '../../shared/types/loop.types';

describe('loop artifact bounds', () => {
  let cwd: string;
  let machine: LoopStageMachine;
  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'loop-artifact-bounds-'));
    machine = new LoopStageMachine(cwd, 'loop-bounds');
    await machine.bootstrap(defaultLoopConfig(cwd, 'finish work'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('trims em dash and arrow notes once, preserving the Completion Inventory', async () => {
    const inventory = '## Completion Inventory\n- [ ] keep this item\n';
    writeFileSync(machine.paths.notes, `# Loop Notes\n${inventory}\n## Work\n${'—→ work\n'.repeat(5_000)}`);
    expect((await machine.curateNotesIfNeeded()).changed).toBe(true);
    const curated = readFileSync(machine.paths.notes, 'utf8');
    expect(curated.length).toBeLessThan(13_000);
    expect(curated).toContain(inventory.trim());
    expect(curated).not.toContain('\uFFFD');
    expect((await machine.curateNotesIfNeeded()).changed).toBe(false);
  });

  it('preserves the top inventory even above the bounded read cap', async () => {
    const inventory = '## Completion Inventory\n- [ ] keep this item\n';
    writeFileSync(machine.paths.notes, `# Loop Notes\n${inventory}\n## Work\n${'—→ work\n'.repeat(25_000)}`);
    await machine.curateNotesIfNeeded();
    const curated = readFileSync(machine.paths.notes, 'utf8');
    expect(curated).toContain(inventory.trim());
    expect(curated).not.toContain('\uFFFD');
  });

  it('keeps complete emoji in an unterminated default-curation tail and preserves inventory', async () => {
    const inventory = '## Completion Inventory\n- [x] completed work\n- [ ] remaining work\n';
    const content = `# Loop Notes\n${inventory}\n## Recent entries\n${'🙂'.repeat(13_000)}x`;
    // The file fits the reader; only the character-based curation cut splits an emoji.
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(128 * 1024);
    writeFileSync(machine.paths.notes, content, 'utf8');

    expect((await machine.curateNotesIfNeeded()).changed).toBe(true);
    const curated = readFileSync(machine.paths.notes, 'utf8');
    expect(curated).not.toContain('\uFFFD');
    expect(curated).toContain(`${'🙂'.repeat(5_999)}x`);
    expect(curated).not.toContain('🙂'.repeat(6_000));
    expect(curated).toContain(inventory.trim());
    expect(curated.match(/## Completion Inventory/g)).toHaveLength(1);
    expect(curated.length).toBeLessThan(13_000);
    expect((await machine.curateNotesIfNeeded()).changed).toBe(false);
    expect(readFileSync(machine.paths.notes, 'utf8')).toBe(curated);
  });

  it('preserves newest newline-ended Unicode notes through default curation and a second pass', async () => {
    const inventory = '## Completion Inventory\n- [ ] retain this item\n';
    const newest = '## Newest note\n🙂 Completed the latest task → keep this note.\n';
    const content = `# Loop Notes\n${inventory}\n## Recent entries\n${'🙂'.repeat(13_000)}x\n${newest}`;
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(128 * 1024);
    writeFileSync(machine.paths.notes, content, 'utf8');

    expect((await machine.curateNotesIfNeeded()).changed).toBe(true);
    const curated = readFileSync(machine.paths.notes, 'utf8');
    expect(curated).not.toContain('\uFFFD');
    expect(curated).toContain(newest);
    expect(curated).toContain(inventory.trim());
    expect(curated.length).toBeLessThan(13_000);
    expect((await machine.curateNotesIfNeeded()).changed).toBe(false);
    expect(readFileSync(machine.paths.notes, 'utf8')).toBe(curated);
  });

  it('trims to newest whole iteration entries past 64 KB without replacement characters', async () => {
    writeFileSync(machine.paths.iterationLog, '# Iteration Log\n' + Array.from({ length: 140 }, (_, i) => `\n## Iteration ${i + 1} — IMPLEMENT — OK\n${'→'.repeat(180)}\n`).join(''));
    await machine.appendIterationLog({ seq: 140, stage: 'IMPLEMENT', verdict: 'OK', tokens: 1, durationMs: 1, filesChanged: 0, progressNotes: [], completionNotes: [] });
    const log = readFileSync(machine.paths.iterationLog, 'utf8');
    expect(Buffer.byteLength(log)).toBeLessThan(64 * 1024);
    expect(log).toContain('## Iteration 141');
    expect(log).not.toContain('## Iteration 1 —');
    expect(log).not.toContain('\uFFFD');
    expect(log).toContain('Harness keeps every iteration in its run history');
  });

  it('collapses repeated progress and completion signal blocks', async () => {
    const entry = { stage: 'IMPLEMENT' as const, verdict: 'OK' as const, tokens: 1, durationMs: 1, filesChanged: 0, progressNotes: ['same progress'], completionNotes: ['same completion'] };
    for (let seq = 0; seq < 3; seq++) await machine.appendIterationLog({ ...entry, seq });
    const log = readFileSync(machine.paths.iterationLog, 'utf8');
    expect(log.match(/ {2}- same progress/g)).toHaveLength(1);
    expect(log.match(/ {2}- same completion/g)).toHaveLength(1);
    expect(log).toContain('- progress signals: same as previous iteration');
    expect(log).toContain('- completion signals fired: same as previous iteration');
  });

  it('gated prompts no longer point at the iteration log', () => {
    expect(machine.buildPrompt({ config: defaultLoopConfig(cwd, 'finish work'), iterationSeq: 0, pendingInterventions: [] })).not.toContain('ITERATION_LOG.md');
  });
});
