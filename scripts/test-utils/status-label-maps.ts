/**
 * Finds local maps of session-status words in a source file. Used by
 * `src/shared/attention/instance-status-presentation.guard.spec.ts`, which
 * fails when a new one appears.
 *
 * What counts as a local status map (any of these, using three or more of the
 * names only a session status has, such as `thinking_deeply` or `respawning`):
 *  - a `Record<InstanceStatus, string | boolean>` declaration;
 *  - an object literal keyed by those names with string or boolean values;
 *  - a `switch` over those names that returns a string.
 * Generic status names (`idle`, `error`, `failed`, `cancelled`) are left out of
 * the key set on purpose: loops, automations and jobs use them too.
 */

import ts from 'typescript';
import { lineOf, propertyKey, unwrap } from './source-scan';

/** Names that belong to a session (instance) status and to nothing else. */
export const SESSION_ONLY_STATUSES: ReadonlySet<string> = new Set([
  'initializing', 'processing', 'thinking_deeply', 'waiting_for_input', 'waiting_for_permission',
  'interrupting', 'cancelling', 'interrupt-escalating', 'superseded', 'respawning', 'hibernating',
  'hibernated', 'waking', 'degraded',
]);

const MIN_SESSION_ONLY_NAMES = 3;

export interface StatusMapHit { line: number; kind: 'record' | 'object' | 'switch' }

const isTextOrFlag = (node: ts.Expression): boolean => {
  const value = unwrap(node);
  return ts.isStringLiteralLike(value)
    || ts.isNoSubstitutionTemplateLiteral(value)
    || value.kind === ts.SyntaxKind.TrueKeyword
    || value.kind === ts.SyntaxKind.FalseKeyword;
};

export function findLocalStatusMaps(file: ts.SourceFile): StatusMapHit[] {
  const hits: StatusMapHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Record') {
      const [key, value] = node.typeArguments ?? [];
      if (
        key && ts.isTypeReferenceNode(key) && ts.isIdentifier(key.typeName) && key.typeName.text === 'InstanceStatus'
        && value && (value.kind === ts.SyntaxKind.StringKeyword || value.kind === ts.SyntaxKind.BooleanKeyword)
      ) {
        hits.push({ line: lineOf(file, node), kind: 'record' });
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const named = node.properties.filter((property) =>
        ts.isPropertyAssignment(property)
        && SESSION_ONLY_STATUSES.has(propertyKey(property.name) ?? '')
        && isTextOrFlag(property.initializer));
      if (named.length >= MIN_SESSION_ONLY_NAMES) hits.push({ line: lineOf(file, node), kind: 'object' });
    }

    if (ts.isSwitchStatement(node)) {
      const clauses = node.caseBlock.clauses;
      const named = new Set<string>();
      clauses.forEach((clause, index) => {
        if (!ts.isCaseClause(clause) || !ts.isStringLiteralLike(clause.expression)) return;
        if (!SESSION_ONLY_STATUSES.has(clause.expression.text)) return;
        // Stacked cases share the statements of the first clause that has any.
        const body = clauses.slice(index).find((later) => later.statements.length > 0);
        const returned = body?.statements.find(ts.isReturnStatement)?.expression;
        if (returned && ts.isStringLiteralLike(unwrap(returned))) named.add(clause.expression.text);
      });
      if (named.size >= MIN_SESSION_ONLY_NAMES) hits.push({ line: lineOf(file, node), kind: 'switch' });
    }

    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}
