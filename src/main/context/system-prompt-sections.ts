/** Bounded section names for delivery diagnostics, excluding fenced-code headings. */
export function omittedSectionHeadings(content: string, from: number, to = content.length): string[] {
  const sections: { title: string; start: number }[] = [];
  let offset = 0;
  let fence: string | undefined;
  for (const line of content.split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s{0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
    } else if (!fence) {
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (heading) sections.push({ title: heading[1].slice(0, 120), start: offset });
    }
    offset += line.length + 1;
  }
  return [...new Set(sections.filter((section, index) => section.start < to &&
    (sections[index + 1]?.start ?? content.length) > from).map((section) => section.title))].slice(0, 12);
}


/** JSON labels remain data even when a source heading contains delimiters. */
export function formatOmittedSectionNames(headings: string[], maxChars: number): string {
  const names: string[] = [];
  const encode = () => JSON.stringify(names).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  for (const heading of headings) {
    names.push(heading);
    if (encode().length > maxChars) { names.pop(); break; }
  }
  return encode();
}
