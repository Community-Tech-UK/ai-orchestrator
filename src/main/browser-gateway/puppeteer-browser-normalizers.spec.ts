import { describe, expect, it } from 'vitest';
import { normalizeAxTreeNodes } from './puppeteer-browser-normalizers';

// The managed-profile normalizer had no coverage at all, so the editable-host
// exemption shipped unverified on that path while the shared tool description
// promised it. These pin the same behaviour the extension path is pinned to.

function axNode(
  backendDOMNodeId: number,
  role: string,
  properties: { name: string; value: { value: unknown } }[] = [],
  name = '',
) {
  return {
    backendDOMNodeId,
    role: { value: role },
    name: { value: name },
    ignored: false,
    properties,
  };
}

const EDITABLE = { name: 'editable', value: { value: 'richtext' } };
const FOCUSABLE = { name: 'focusable', value: { value: true } };

describe('normalizeAxTreeNodes editable handling', () => {
  it('keeps a contenteditable host that Chrome types as role generic', () => {
    const nodes = normalizeAxTreeNodes(
      { nodes: [axNode(1, 'generic', [EDITABLE, FOCUSABLE])] },
      { interestingOnly: true, limit: 50 },
    );

    // Without the exemption an unconditional `generic` drop removes the body of
    // every rich-text editor from the managed-profile tree.
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.editable).toBe('richtext');
  });

  it('drops editable descendants that are not focusable', () => {
    const nodes = normalizeAxTreeNodes(
      { nodes: [axNode(2, 'generic', [EDITABLE])] },
      { interestingOnly: true, limit: 50 },
    );

    expect(nodes).toHaveLength(0);
  });

  it('does not mark the frame document as editable', () => {
    const nodes = normalizeAxTreeNodes(
      { nodes: [axNode(3, 'RootWebArea', [EDITABLE, FOCUSABLE])] },
      { interestingOnly: true, limit: 50 },
    );

    // RootWebArea reports editable+focusable but is a #document, not a typeable
    // target. Marking it sends an agent at a node that cannot accept a write.
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.editable).toBeUndefined();
  });

  it('does not mark a paragraph inside an editable region', () => {
    const nodes = normalizeAxTreeNodes(
      { nodes: [axNode(4, 'paragraph', [EDITABLE], 'para one')] },
      { interestingOnly: true, limit: 50 },
    );

    // A paragraph inside a contenteditable ACCEPTS a write and reports success,
    // so marking it points an agent at overwriting one paragraph of the editor
    // and being told it worked.
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.editable).toBeUndefined();
  });

  it('still drops a plain generic wrapper', () => {
    const nodes = normalizeAxTreeNodes(
      { nodes: [axNode(5, 'generic')] },
      { interestingOnly: true, limit: 50 },
    );

    expect(nodes).toHaveLength(0);
  });
});
