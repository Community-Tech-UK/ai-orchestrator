/**
 * The Computers page's order, in one place so the page and the Plan Queue read it the same way: paired computers in the
 * saved order, then any not yet in it; and which computer each test machine is part of.
 */

export interface OrderableComputer { id: string; name: string }

/** Paired computers in the saved order, then any not yet in it, in the order given. */
export function orderComputers<N extends OrderableComputer>(nodes: readonly N[], choices: readonly { id: string }[]): N[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const listed = choices.filter(choice => byId.has(choice.id)).map(choice => byId.get(choice.id)!);
  return [...listed, ...nodes.filter(node => !choices.some(choice => choice.id === node.id))];
}

/**
 * A test machine goes with the first computer, in `ordered`, whose name its file gives, so two computers with one name
 * share none, and a computer has at most one.
 */
export function ownTestMachines<N extends OrderableComputer, M extends { nodeName: string | null }>(
  ordered: readonly N[],
  machines: readonly M[],
): Map<N, M> {
  const owned = new Map<N, M>();
  for (const machine of machines) {
    const owner = machine.nodeName ? ordered.find(node => node.name === machine.nodeName && !owned.has(node)) : undefined;
    if (owner) owned.set(owner, machine);
  }
  return owned;
}
