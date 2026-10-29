import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Enumerate production calls so moving triage or adding a spawn cannot evade the policy. */
describe('plan queue machine session call-site guard', () => {
  it('tags every createInstance call with its queue role and run', () => {
    const directory = join(process.cwd(), 'src/main/plan-queue');
    const calls: Array<{ file: string; role: string; hasRun: boolean }> = [];
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))) {
      const source = ts.createSourceFile(file, readFileSync(join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true);
      const property = (object: ts.ObjectLiteralExpression, name: string) => object.properties.find(
        (entry): entry is ts.PropertyAssignment => ts.isPropertyAssignment(entry) && entry.name.getText(source) === name,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createInstance') {
          const options = node.arguments[0];
          if (file === 'plan-queue-spawn.ts') {
            // Both the reopen and fresh fallback retain the routed config's tags.
            const declarations = source.statements.filter(ts.isFunctionDeclaration)
              .flatMap(fn => fn.body?.statements ?? [])
              .filter(ts.isVariableStatement)
              .flatMap(statement => statement.declarationList.declarations);
            const route = declarations.find(declaration => declaration.name.getText(source) === 'route')?.initializer;
            expect(route && ts.isCallExpression(route) && route.expression.getText(source)).toBe('routeQueueSpawn');
            expect(route && ts.isCallExpression(route) && route.arguments[0].getText(source)).toBe('config');
            if (options && ts.isConditionalExpression(options)) {
              expect(options.whenFalse.getText(source)).toBe('route');
              expect(ts.isObjectLiteralExpression(options.whenTrue)).toBe(true);
              if (ts.isObjectLiteralExpression(options.whenTrue)) {
                expect(options.whenTrue.properties[0].getText(source)).toBe('...route');
                expect(property(options.whenTrue, 'metadata')).toBeUndefined();
              }
            } else expect(options?.getText(source)).toBe('route');
            calls.push({ file, role: 'forwarded', hasRun: true });
            ts.forEachChild(node, visit);
            return;
          }
          const metadata = options && ts.isObjectLiteralExpression(options) ? property(options, 'metadata')?.initializer : undefined;
          const role = metadata && ts.isObjectLiteralExpression(metadata) ? property(metadata, 'planQueueRole')?.initializer : undefined;
          calls.push({ file, role: role && ts.isStringLiteral(role) ? role.text : 'MISSING',
            hasRun: Boolean(metadata && ts.isObjectLiteralExpression(metadata) && property(metadata, 'planQueueRunId')) });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(calls.sort((a, b) => a.role.localeCompare(b.role))).toEqual([
      { file: 'plan-queue-spawn.ts', role: 'forwarded', hasRun: true },
      { file: 'plan-queue-spawn.ts', role: 'forwarded', hasRun: true },
      { file: 'plan-queue-triage.ts', role: 'triage', hasRun: true },
      { file: 'plan-queue-item-flow.ts', role: 'verifier', hasRun: true },
      { file: 'plan-queue-item-flow.ts', role: 'worker', hasRun: true },
    ]);
  });
});
