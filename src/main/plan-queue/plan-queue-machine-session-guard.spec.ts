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
          if (file === 'plan-queue-coordinator.ts') {
            // The close fence forwards the already-tagged options without rebuilding
            // them, optionally through the routing wrapper (which spreads them and
            // keeps the queue tags).
            const forwarded = options && ts.isCallExpression(options) && ts.isIdentifier(options.expression)
              && options.expression.text === 'routeQueueSpawn' ? options.arguments[0] : options;
            expect(forwarded?.getText(source)).toBe('config');
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
      { file: 'plan-queue-coordinator.ts', role: 'forwarded', hasRun: true },
      { file: 'plan-queue-triage.ts', role: 'triage', hasRun: true },
      { file: 'plan-queue-item-flow.ts', role: 'verifier', hasRun: true },
      { file: 'plan-queue-item-flow.ts', role: 'worker', hasRun: true },
    ]);
  });
});
