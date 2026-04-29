export function parseArgsFromQuery(query: string, commandNameOrAlias?: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1).trimStart() : trimmed;
  if (!withoutSlash) return [];

  if (commandNameOrAlias) {
    const escaped = commandNameOrAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = withoutSlash.match(new RegExp(`^${escaped}(?:\\s+|$)`, 'i'));
    if (match) {
      return splitArgs(withoutSlash.slice(match[0].length));
    }
  }

  const firstWhitespace = withoutSlash.search(/\s/);
  if (firstWhitespace === -1) return [];
  return splitArgs(withoutSlash.slice(firstWhitespace + 1));
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += '\\';
  }
  if (current) {
    args.push(current);
  }

  return args;
}
