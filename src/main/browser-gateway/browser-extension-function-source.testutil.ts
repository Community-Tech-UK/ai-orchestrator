/**
 * Extract a top-level `function name() { … }` verbatim from extension source by
 * brace-matching, so specs can run the REAL shipped code rather than a copy.
 *
 * The extension runs in a service worker and cannot be imported, so this is the
 * only way a spec can bind to what actually ships. Breakage is loud: a renamed
 * function throws here, and a mis-sliced body fails to parse.
 *
 * Only sound for functions with no brace inside a string, template literal,
 * regex or comment — true of the functions currently extracted. Default
 * object parameters are supported by locating the body only after the closing
 * parameter parenthesis. A leading `async` is preserved; slicing from
 * `function` alone strips it and the body then fails to parse on its first
 * `await`.
 */
export function extractFunctionSource(source: string, name: string): string {
  const declaration = source.indexOf(`function ${name}(`);
  if (declaration === -1) {
    throw new Error(`function ${name} not found in extension source`);
  }
  const ASYNC = 'async ';
  const start = source.slice(declaration - ASYNC.length, declaration) === ASYNC
    ? declaration - ASYNC.length
    : declaration;
  let depth = 0;
  let seenBrace = false;
  let parameterDepth = 0;
  let seenParameters = false;
  let parameterEnd = -1;
  for (let j = source.indexOf('(', declaration); j < source.length; j++) {
    const ch = source[j];
    if (ch === '(') {
      parameterDepth++;
      seenParameters = true;
    } else if (ch === ')') {
      parameterDepth--;
      if (seenParameters && parameterDepth === 0) {
        parameterEnd = j;
        break;
      }
    }
  }
  if (parameterEnd === -1) {
    throw new Error(`Unbalanced parameters extracting ${name}`);
  }
  let i = source.indexOf('{', parameterEnd);
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      seenBrace = true;
    } else if (ch === '}') {
      depth--;
      if (seenBrace && depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces extracting ${name}`);
}
