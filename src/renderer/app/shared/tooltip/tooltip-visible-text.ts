/** Text the user can read, excluding hidden and screen-reader-only subtrees. */
export function visibleTextOf(root: Element): string {
  const view = root.ownerDocument.defaultView;
  if (!view) return root.textContent ?? '';

  function hidesSubtree(element: Element): boolean {
    return element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true'
      || element.classList.contains('sr-only') || element.classList.contains('visually-hidden')
      || view!.getComputedStyle(element).display === 'none';
  }

  for (let ancestor: Element | null = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (hidesSubtree(ancestor)) return '';
  }

  function visit(element: Element): string {
    if (hidesSubtree(element) || /^(SCRIPT|STYLE|TEMPLATE)$/i.test(element.tagName) ||
        (element.namespaceURI === 'http://www.w3.org/2000/svg' && element.localName === 'title')) {
      return '';
    }
    const style = view!.getComputedStyle(element);
    return Array.from(element.childNodes).map((node) => {
      if (node.nodeType === 3) {
        return style.visibility === 'hidden' || style.visibility === 'collapse' ? '' : node.textContent ?? '';
      }
      return node.nodeType === 1 ? visit(node as Element) : '';
    }).join('');
  }

  return visit(root);
}
