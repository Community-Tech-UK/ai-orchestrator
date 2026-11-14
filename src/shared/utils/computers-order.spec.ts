import { describe, expect, it } from 'vitest';
import { orderComputers, ownTestMachines } from './computers-order';

const node = (id: string, name = id) => ({ id, name });

describe('orderComputers', () => {
  it('puts saved computers first in the saved order, then the rest in the order given', () => {
    const ordered = orderComputers([node('a'), node('b'), node('c'), node('d')], [{ id: 'c' }, { id: 'a' }]);
    expect(ordered.map(entry => entry.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('ignores a saved choice for a computer that is no longer paired', () => {
    expect(orderComputers([node('a')], [{ id: 'gone' }, { id: 'a' }]).map(entry => entry.id)).toEqual(['a']);
  });
});

describe('ownTestMachines', () => {
  it('gives each machine to the first computer with its name and a computer at most one machine', () => {
    const first = node('one', 'pc');
    const second = node('two', 'pc');
    const owned = ownTestMachines([first, second], [{ nodeName: 'pc' }, { nodeName: 'pc' }, { nodeName: null }, { nodeName: 'nobody' }]);
    expect([...owned.keys()]).toEqual([first, second]);
  });
});
