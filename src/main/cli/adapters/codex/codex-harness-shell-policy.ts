/** Keep the current spawn's CLI bridge reachable through Codex's shell filter.
 * Values live only in the private prepared home, never in process arguments.
 * Span edits preserve every unrelated setting, including the inheritance policy.
 */
const HARNESS_CLI_KEYS = [
  'AIO_MCP',
  'AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET',
  'AI_ORCHESTRATOR_INSTANCE_ID',
  'AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY',
] as const;

interface ValueSpan { path: string[]; start: number; end: number; inline: boolean }
interface TableSpan { path: string[]; end: number }
interface Edit { start: number; end: number; text: string }

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function prefixOf(prefix: string[], path: string[]): boolean {
  return prefix.every((key, index) => key === path[index]);
}

/** Skip TOML trivia, including comments; no secret-containing text is logged. */
function skipTrivia(text: string, start: number, end = text.length): number {
  let position = start;
  while (position < end) {
    if (/\s/.test(text[position]!)) position++;
    else if (text[position] === '#') {
      const newline = text.indexOf('\n', position);
      position = newline < 0 ? end : newline + 1;
    } else break;
  }
  return position;
}

function quotedEnd(text: string, start: number): number {
  const quote = text[start]!;
  const triple = text.slice(start, start + 3) === quote.repeat(3);
  const marker = triple ? quote.repeat(3) : quote;
  let position = start + marker.length;
  while (position < text.length) {
    if (quote === '"' && text[position] === '\\') { position += 2; continue; }
    if (text.slice(position, position + marker.length) === marker) {
      position += marker.length;
      // TOML multiline strings can end with four/five quotes.
      if (triple) while (position < text.length && text[position] === quote) position++;
      return position;
    }
    position++;
  }
  throw new Error('Could not preserve Codex shell policy: unterminated TOML string');
}

function keyPath(raw: string): string[] {
  const parts: string[] = [];
  let position = 0;
  while (position < raw.length) {
    position = skipTrivia(raw, position);
    const start = position;
    if (raw[position] === '"' || raw[position] === "'") {
      position = quotedEnd(raw, position);
      const value = raw.slice(start, position);
      try { parts.push(value[0] === '"' ? JSON.parse(value) as string : value.slice(1, -1)); }
      catch { throw new Error('Could not preserve Codex shell policy: unsupported quoted TOML key'); }
    } else {
      while (position < raw.length && /[A-Za-z0-9_-]/.test(raw[position]!)) position++;
      if (position === start) throw new Error('Could not preserve Codex shell policy: invalid TOML key');
      parts.push(raw.slice(start, position));
    }
    position = skipTrivia(raw, position);
    if (position === raw.length) break;
    if (raw[position++] !== '.') throw new Error('Could not preserve Codex shell policy: invalid TOML key');
  }
  return parts;
}

function valueEnd(text: string, start: number, inline: boolean): number {
  let depth = 0;
  let position = start;
  while (position < text.length) {
    const char = text[position]!;
    if (char === '"' || char === "'") { position = quotedEnd(text, position); continue; }
    if (char === '#') {
      if (depth === 0) return position;
      const newline = text.indexOf('\n', position);
      position = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (depth === 0 && (char === '\n' || inline && (char === ',' || char === '}'))) return position;
    if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
    if (depth < 0) throw new Error('Could not preserve Codex shell policy: invalid TOML value');
    position++;
  }
  if (depth !== 0) throw new Error('Could not preserve Codex shell policy: unterminated TOML value');
  return position;
}

function assignmentEquals(text: string, start: number): number {
  let position = start;
  while (position < text.length) {
    const char = text[position]!;
    if (char === '"' || char === "'") { position = quotedEnd(text, position); continue; }
    if (char === '=') return position;
    if (char === '\n' || char === '#') break;
    position++;
  }
  throw new Error('Could not preserve Codex shell policy: invalid TOML assignment');
}

function readSpans(text: string): { values: ValueSpan[]; tables: TableSpan[] } {
  const values: ValueSpan[] = [];
  const tables: TableSpan[] = [{ path: [], end: text.length }];
  let table = tables[0]!;
  let position = 0;
  const readValue = (path: string[], start: number, end: number): void => {
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    const inline = text[start] === '{';
    values.push({ path, start, end, inline });
    if (!inline) return;
    let child = skipTrivia(text, start + 1, end - 1);
    while (child < end - 1) {
      const equals = assignmentEquals(text, child);
      const childStart = skipTrivia(text, equals + 1);
      const childEnd = valueEnd(text, childStart, true);
      readValue([...path, ...keyPath(text.slice(child, equals))], childStart, childEnd);
      child = skipTrivia(text, childEnd, end - 1);
      if (text[child] === ',') child = skipTrivia(text, child + 1, end - 1);
      else if (child < end - 1) throw new Error('Could not preserve Codex shell policy: invalid inline table');
    }
  };
  while ((position = skipTrivia(text, position)) < text.length) {
    if (text[position] === '[') {
      table.end = position;
      const arrayTable = text[position + 1] === '[';
      const start = position + (arrayTable ? 2 : 1);
      position = start;
      while (position < text.length && text[position] !== ']') {
        if (text[position] === '"' || text[position] === "'") position = quotedEnd(text, position);
        else position++;
      }
      if (position === text.length) throw new Error('Could not preserve Codex shell policy: invalid TOML table');
      table = { path: keyPath(text.slice(start, position)), end: text.length };
      tables.push(table);
      position += arrayTable ? 2 : 1;
    } else {
      const equals = assignmentEquals(text, position);
      const start = skipTrivia(text, equals + 1);
      const end = valueEnd(text, start, false);
      readValue([...table.path, ...keyPath(text.slice(position, equals))], start, end);
      position = end;
    }
  }
  return { values, tables };
}

function extendIncludeOnly(raw: string): string {
  if (!raw.startsWith('[') || !raw.endsWith(']')) {
    throw new Error('Could not preserve Codex shell policy: include_only must be an array');
  }
  const entries: string[] = [];
  let position = skipTrivia(raw, 1, raw.length - 1);
  while (position < raw.length - 1) {
    if (raw[position] !== '"' && raw[position] !== "'") {
      throw new Error('Could not preserve Codex shell policy: include_only must contain strings');
    }
    const end = quotedEnd(raw, position);
    entries.push(raw.slice(position, end));
    position = skipTrivia(raw, end, raw.length - 1);
    if (raw[position] === ',') position = skipTrivia(raw, position + 1, raw.length - 1);
    else if (position < raw.length - 1) throw new Error('Could not preserve Codex shell policy: invalid include_only array');
  }
  // An empty array means no allow-only filter; adding names would narrow it.
  if (entries.length === 0) return raw;
  for (const key of HARNESS_CLI_KEYS) {
    if (!entries.includes(JSON.stringify(key)) && !entries.includes(`'${key}'`)) entries.push(JSON.stringify(key));
  }
  return `[${entries.join(', ')}]`;
}

export function preserveHarnessCliShellPolicy(config: string, env?: Record<string, string>): string {
  if (!env || HARNESS_CLI_KEYS.some((key) => !env[key])) return config;
  const { values, tables } = readSpans(config);
  const edits: Edit[] = [];
  const insertions = new Map<number, string[]>();
  const insert = (at: number, text: string): void => {
    const existing = insertions.get(at) ?? [];
    existing.push(text);
    insertions.set(at, existing);
  };
  const includeOnly = values.find((span) => samePath(span.path, ['shell_environment_policy', 'include_only']));
  if (includeOnly) edits.push({ ...includeOnly, text: extendIncludeOnly(config.slice(includeOnly.start, includeOnly.end)) });
  for (const key of HARNESS_CLI_KEYS) {
    const target = ['shell_environment_policy', 'set', key];
    const value = JSON.stringify(env[key]);
    const existing = values.find((span) => samePath(span.path, target));
    if (existing) { edits.push({ ...existing, text: value }); continue; }
    const ancestor = values.filter((span) => span.inline && prefixOf(span.path, target))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (ancestor) {
      insert(ancestor.end - 1, `${target.slice(ancestor.path.length).join('.')} = ${value}`);
      continue;
    }
    const scope = tables.filter((span) => prefixOf(span.path, target) && span.path.length < target.length)
      .sort((a, b) => b.path.length - a.path.length)[0]!;
    insert(scope.end, `${target.slice(scope.path.length).join('.')} = ${value}`);
  }
  for (const [at, entries] of insertions) {
    const inline = values.find((span) => span.inline && span.end - 1 === at);
    if (inline) {
      const lastChildEnd = values.filter((span) => span.start > inline.start && span.end < inline.end)
        .reduce((end, span) => Math.max(end, span.end), inline.start + 1);
      const next = skipTrivia(config, lastChildEnd, at);
      const separator = lastChildEnd > inline.start + 1 && config[next] !== ',' ? ', ' : ' ';
      edits.push({ start: at, end: at, text: `${separator}${entries.join(', ')} ` });
    } else edits.push({ start: at, end: at, text: `${at > 0 && config[at - 1] !== '\n' ? '\n' : ''}${entries.join('\n')}\n` });
  }
  let result = config;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}
