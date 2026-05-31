import { describe, it, expect } from 'vitest';
import { ToolsetRegistry, createToolsetRegistry } from './toolsets';

describe('ToolsetRegistry', () => {
  it('resolves a flat toolset preserving order and de-duping', () => {
    const r = new ToolsetRegistry().register({ name: 'a', tools: ['x', 'y', 'x', 'z'] });
    expect(r.resolve('a')).toEqual(['x', 'y', 'z']);
  });

  it('composes via includes (recursive), includes-first then own tools', () => {
    const r = createToolsetRegistry([
      { name: 'read', tools: ['read_file', 'list_dir'] },
      { name: 'write', tools: ['write_file'] },
      { name: 'edit', includes: ['read', 'write'], tools: ['apply_patch'] },
    ]);
    expect(r.resolve('edit')).toEqual(['read_file', 'list_dir', 'write_file', 'apply_patch']);
  });

  it('expands "*" against allTools', () => {
    const r = new ToolsetRegistry().register({ name: 'all', tools: ['*'] });
    expect(r.resolve('all', { allTools: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c']);
  });

  it('supports the deny-all-then-allow grammar ["*", "!x"] (#18c)', () => {
    const r = new ToolsetRegistry().register({ name: 'safe', tools: ['*', '!spawn_child', '!run_on_node'] });
    expect(r.resolve('safe', { allTools: ['read', 'spawn_child', 'run_on_node', 'write'] }))
      .toEqual(['read', 'write']);
  });

  it('removes by namespaced-prefix and wildcard', () => {
    const r = new ToolsetRegistry().register({ name: 't', tools: ['*', '!mcp__danger*', '!fs'] });
    const out = r.resolve('t', { allTools: ['fs', 'fs__read', 'mcp__danger__a', 'mcp__safe__b', 'keep'] });
    // "!fs" drops "fs" and the namespaced "fs__read"; "!mcp__danger*" drops the danger ns.
    expect(out).toEqual(['mcp__safe__b', 'keep']);
  });

  it('lets a later "!x" override an earlier include that added x', () => {
    const r = createToolsetRegistry([
      { name: 'base', tools: ['a', 'b', 'c'] },
      { name: 'restricted', includes: ['base'], tools: ['!b'] },
    ]);
    expect(r.resolve('restricted')).toEqual(['a', 'c']);
  });

  it('applies the isAvailable check_fn to drop unavailable tools', () => {
    const r = new ToolsetRegistry().register({ name: 't', tools: ['a', 'b', 'c'] });
    expect(r.resolve('t', { isAvailable: (id) => id !== 'b' })).toEqual(['a', 'c']);
  });

  it('is cycle-safe across mutually-including toolsets', () => {
    const r = createToolsetRegistry([
      { name: 'x', includes: ['y'], tools: ['x1'] },
      { name: 'y', includes: ['x'], tools: ['y1'] },
    ]);
    // No infinite loop; each contributes once.
    expect(r.resolve('x').sort()).toEqual(['x1', 'y1']);
  });

  it('throws on unknown toolset and unknown include', () => {
    const r = new ToolsetRegistry();
    expect(() => r.resolve('nope')).toThrow(/Unknown toolset/);
    r.register({ name: 'a', includes: ['missing'] });
    expect(() => r.resolve('a')).toThrow(/unknown toolset "missing"/);
  });

  it('resolveDefinition works for ad-hoc (unregistered) definitions', () => {
    const r = createToolsetRegistry([{ name: 'read', tools: ['read_file'] }]);
    expect(r.resolveDefinition({ name: 'adhoc', includes: ['read'], tools: ['extra'] }))
      .toEqual(['read_file', 'extra']);
  });

  it('register/has/get/list behave', () => {
    const r = new ToolsetRegistry();
    expect(r.has('a')).toBe(false);
    r.register({ name: 'a', tools: ['x'] });
    expect(r.has('a')).toBe(true);
    expect(r.get('a')?.tools).toEqual(['x']);
    expect(r.list()).toEqual(['a']);
    expect(() => r.register({ name: '' })).toThrow(/requires a name/);
  });
});
