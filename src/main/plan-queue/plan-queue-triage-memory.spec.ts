import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { triageMemoryKey } from './plan-queue-triage-memory';

let root: string;
let outside: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aio-triage-memory-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'aio-triage-outside-')));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

describe('bounded, repository-scoped triage memory', () => {
  it('does not reuse an identity for a linked spec outside the repository or through a symlink', () => {
    const spec = join(outside, 'other_spec.md');
    writeFileSync(spec, 'outside');
    const plan = join(root, 'x_plan.md');
    writeFileSync(plan, `**Spec:** [spec](${spec})\n`);
    expect(triageMemoryKey(plan, root)).toBeNull();
    symlinkSync(spec, join(root, 'linked.md'));
    writeFileSync(plan, '**Spec:** [spec](linked.md)\n');
    expect(triageMemoryKey(plan, root)).toBeNull();
  });
  it('declines caching oversized inputs instead of reading them synchronously without a bound', () => {
    const plan = join(root, 'large_plan.md');
    writeFileSync(plan, 'x'.repeat(1024 * 1024 + 1));
    expect(triageMemoryKey(plan, root)).toBeNull();
  });
  it('includes the complete linked spec bytes and changes identity on a spec-only edit', () => {
    const plan = join(root, 'x_plan.md');
    const spec = join(root, 'x_spec_planned.md');
    writeFileSync(plan, '**Spec:** [spec](x_spec_planned.md)\n');
    writeFileSync(spec, 'first');
    const first = triageMemoryKey(plan, root);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(spec, 'second');
    expect(triageMemoryKey(plan, root)).not.toBe(first);
  });
});
