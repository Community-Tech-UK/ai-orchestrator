import { parseTOML, type AST } from 'toml-eslint-parser';

interface Edit { start: number; end: number; text: string; }

function keyParts(key: AST.TOMLKey): string[] {
  return key.keys.map((part) => part.type === 'TOMLBare' ? part.name : part.value);
}

/** Keep user configuration verbatim except for server names owned by this spawn. */
export function mergeCodexMcpConfig(userConfig: string, injectedConfig: string, stripUserServers: boolean): string {
  const injected = parseTOML(injectedConfig, { tomlVersion: '1.1' });
  const ownedNames = new Set<string>();
  const collect = (node: AST.TOMLKeyValue, base: (string | number)[]): void => {
    const path = [...base, ...keyParts(node.key)];
    if (path[0] !== 'mcp_servers') return;
    if (typeof path[1] === 'string') ownedNames.add(path[1]);
    else if (node.value.type === 'TOMLInlineTable') {
      for (const child of node.value.body) collect(child, path);
    }
  };
  for (const entry of injected.body[0].body) {
    if (entry.type === 'TOMLTable') {
      if (entry.resolvedKey[0] === 'mcp_servers' && typeof entry.resolvedKey[1] === 'string') {
        ownedNames.add(entry.resolvedKey[1]);
      }
      for (const node of entry.body) collect(node, entry.resolvedKey);
    } else collect(entry, []);
  }

  const edits: Edit[] = [];
  const ownsName = (name: string): boolean => stripUserServers || ownedNames.has(name);
  const removeOwned = (node: AST.TOMLKeyValue, base: (string | number)[]): void => {
    const path = [...base, ...keyParts(node.key)];
    if (path[0] !== 'mcp_servers') return;
    if (typeof path[1] === 'string' && ownsName(path[1])) {
      edits.push({ start: node.range[0], end: node.range[1], text: '' });
    } else if (path.length === 1 && node.value.type === 'TOMLInlineTable') {
      // Inline tables are sealed in TOML. Expand the retained entries into
      // dotted assignments so the injected tables may extend mcp_servers.
      const text = node.value.body
        .filter((child) => !ownsName(keyParts(child.key)[0]!))
        .map((child) => `mcp_servers.${userConfig.slice(...child.key.range)} = ${userConfig.slice(...child.value.range)}`)
        .join('\n');
      edits.push({ start: node.range[0], end: node.range[1], text });
    }
  };
  for (const entry of parseTOML(userConfig, { tomlVersion: '1.1' }).body[0].body) {
    if (entry.type === 'TOMLTable') {
      const [root, name] = entry.resolvedKey;
      if (root === 'mcp_servers' && typeof name === 'string' && ownsName(name)) {
        const trailingWhitespace = userConfig.slice(entry.range[1]).match(/^\s*/)?.[0].length ?? 0;
        edits.push({ start: entry.range[0], end: entry.range[1] + trailingWhitespace, text: '' });
      } else for (const node of entry.body) removeOwned(node, entry.resolvedKey);
    } else removeOwned(entry, []);
  }
  edits.sort((left, right) => right.start - left.start);
  let merged = userConfig;
  for (const edit of edits) merged = merged.slice(0, edit.start) + edit.text + merged.slice(edit.end);
  return [merged.trimEnd(), injectedConfig.trim()].filter(Boolean).join('\n\n');
}
