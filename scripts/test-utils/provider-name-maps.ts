/**
 * Finds local maps of provider display names in a source file. Used by
 * `src/shared/display-names.guard.spec.ts`, which fails when a new one appears.
 *
 * What counts as a local map (any of these, naming two or more providers):
 *  - an object literal keyed by provider ids with display-name strings;
 *  - a `switch` over provider ids that returns display-name strings;
 *  - an array of `{ id|value|provider|key: <provider id>, label|name|...: <display name> }`;
 *  - a chain of `x === '<provider id>' ? '<display name>' : ...`.
 * A display name is a provider's own name with at most a vendor prefix and a
 * tool suffix ("Codex", "OpenAI Codex CLI", "Google Gemini (legacy)"). Colours,
 * model ids and `providerName(...)` calls are not display names.
 */

import ts from 'typescript';
import { lineOf, propertyKey, unwrap } from './source-scan';

export const PROVIDER_IDS: ReadonlySet<string> = new Set([
  'claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode', 'ollama', 'local-model',
]);

// Case-sensitive on purpose: a display name starts with a capital, while the
// provider ids the maps are keyed by (and often map to, e.g. 'claude-cli') do not.
const DISPLAY_NAME = new RegExp(
  '^(?:(?:OpenAI|GitHub|Google|xAI) )?(?:Claude|Codex|Gemini|Antigravity|Copilot|Cursor|Grok|OpenCode|Ollama|MiMo|Local models?|Local Models?)'
  + '(?: (?:Code|CLI|Build|Agent|Chat))*(?: \\([^)]*\\))?$',
);

const LABEL_KEYS: ReadonlySet<string> = new Set(['label', 'name', 'displayName', 'title']);
const ID_KEYS: ReadonlySet<string> = new Set(['id', 'value', 'provider', 'key']);

const isDisplayName = (node: ts.Node | undefined): node is ts.StringLiteralLike =>
  !!node && ts.isStringLiteralLike(node) && DISPLAY_NAME.test(node.text);
const isProviderId = (node: ts.Node | undefined): node is ts.StringLiteralLike =>
  !!node && ts.isStringLiteralLike(node) && PROVIDER_IDS.has(node.text);

export interface LocalMapHit { line: number; kind: 'object' | 'switch' | 'array' | 'chain' }

/** Every local map of provider display names in one source file. */
export function findLocalProviderMaps(file: ts.SourceFile): LocalMapHit[] {
  const hits: LocalMapHit[] = [];
  const chained = new Set<ts.Node>();

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const named = node.properties.filter((property): property is ts.PropertyAssignment => {
        if (!ts.isPropertyAssignment(property)) return false;
        const key = propertyKey(property.name);
        return key !== null && PROVIDER_IDS.has(key) && isDisplayName(unwrap(property.initializer));
      });
      if (named.length >= 2) hits.push({ line: lineOf(file, node), kind: 'object' });
    }

    if (ts.isSwitchStatement(node)) {
      const named = node.caseBlock.clauses.filter((clause) => {
        if (!ts.isCaseClause(clause) || !isProviderId(clause.expression)) return false;
        return clause.statements.some((statement) => {
          if (!ts.isReturnStatement(statement) || !statement.expression) return false;
          const returned = unwrap(statement.expression);
          if (isDisplayName(returned)) return true;
          return ts.isObjectLiteralExpression(returned) && returned.properties.some((property) =>
            ts.isPropertyAssignment(property)
            && LABEL_KEYS.has(propertyKey(property.name) ?? '')
            && isDisplayName(unwrap(property.initializer)));
        });
      });
      if (named.length >= 2) hits.push({ line: lineOf(file, node), kind: 'switch' });
    }

    if (ts.isArrayLiteralExpression(node)) {
      const named = node.elements.filter((element) => {
        if (!ts.isObjectLiteralExpression(element)) return false;
        const properties = element.properties.filter(ts.isPropertyAssignment);
        const hasId = properties.some((property) =>
          ID_KEYS.has(propertyKey(property.name) ?? '') && isProviderId(unwrap(property.initializer)));
        const hasLabel = properties.some((property) =>
          LABEL_KEYS.has(propertyKey(property.name) ?? '') && isDisplayName(unwrap(property.initializer)));
        return hasId && hasLabel;
      });
      if (named.length >= 2) hits.push({ line: lineOf(file, node), kind: 'array' });
    }

    if (ts.isConditionalExpression(node) && !chained.has(node)) {
      let count = 0;
      for (let link: ts.Expression = node; ts.isConditionalExpression(link); link = link.whenFalse) {
        chained.add(link);
        const test = unwrap(link.condition);
        const comparesProvider = ts.isBinaryExpression(test)
          && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(test.operatorToken.kind)
          && (isProviderId(test.left) || isProviderId(test.right));
        if (comparesProvider && isDisplayName(unwrap(link.whenTrue))) count += 1;
      }
      if (count >= 2) hits.push({ line: lineOf(file, node), kind: 'chain' });
    }

    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

/**
 * Rule 2: a provider's tool or product name typed out by hand. Only
 * `src/shared/display-names.ts` may spell these; everything else asks
 * `providerToolName()` / `providerName()` / `accountFamilyName()`.
 *
 * The bare short names (Claude, Codex, Gemini, Copilot, Cursor, Grok, Ollama)
 * are left out on purpose: they are also model families, editors and runtimes
 * in data. Maps of those are caught by `findLocalProviderMaps`.
 */
export const TOOL_NAME_LITERALS: ReadonlySet<string> = new Set([
  'Claude Code', 'Claude Code CLI', 'Claude CLI',
  'OpenAI Codex', 'OpenAI Codex CLI', 'Codex CLI',
  'Google Gemini', 'Google Gemini CLI', 'Google Gemini (legacy)', 'Gemini CLI',
  'Antigravity', 'Google Antigravity',
  'GitHub Copilot', 'Copilot CLI',
  'Cursor CLI', 'Cursor Agent',
  'Grok Build',
  'OpenCode', 'OpenCode CLI',
  'MiMo', 'MiMo via OpenCode',
]);

export interface ToolNameHit { line: number; text: string }

export function findHandWrittenToolNames(file: ts.SourceFile): ToolNameHit[] {
  const hits: ToolNameHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && TOOL_NAME_LITERALS.has(node.text)) {
      const parent = node.parent;
      const specifier = ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent);
      const propertyName = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node;
      if (!specifier && !propertyName) hits.push({ line: lineOf(file, node), text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}
