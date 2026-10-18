/** Text the user can read, for tooltip redundancy checks on collapsed controls. */
export function visibleTextOf(root: Element): string {
  const view = root.ownerDocument.defaultView;
  if (!view) return root.textContent ?? '';

  function visit(element: Element): string {
    if (element.hasAttribute('hidden') ||
        (element.namespaceURI === 'http://www.w3.org/2000/svg' && element.localName === 'title')) {
      return '';
    }
    const style = view!.getComputedStyle(element);
    if (style.display === 'none') return '';

    return Array.from(element.childNodes).map((node) => {
      if (node.nodeType === 3) {
        return style.visibility === 'hidden' || style.visibility === 'collapse' ? '' : node.textContent ?? '';
      }
      return node.nodeType === 1 ? visit(node as Element) : '';
    }).join('');
  }

  return visit(root);
}
