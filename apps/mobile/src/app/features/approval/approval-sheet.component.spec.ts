import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The error paragraph must render for EVERY prompt kind. It first shipped inside
 * two of the four branches, so `kind: 'permission'` — the commonest prompt — showed
 * nothing, and a rejected decision looked like a dead button. A `toContain` check
 * passed anyway, because the markup existed *somewhere* in the file.
 *
 * A real render would be the stronger test, but this app's Vitest setup has no
 * Angular compiler transform, so a component's signal inputs are never registered
 * (`NG0315`/`NG0950`) and `input.required()` components cannot be instantiated.
 * So instead of asserting the markup exists, this asserts the property that was
 * actually violated: that it sits at the top level of the sheet, nested inside no
 * branch at all, and therefore cannot be reachable for some prompts but not others.
 */
describe('ApprovalSheetComponent error placement', () => {
  const source = readFileSync(
    resolve('src/app/features/approval/approval-sheet.component.ts'),
    'utf8',
  );
  const template = source.slice(
    source.indexOf('template: `') + 'template: `'.length,
    source.indexOf('`,\n  styles:'),
  );
  // Interpolations carry braces of their own and would corrupt the depth count.
  const controlFlow = template.replace(/\{\{[^}]*\}\}/g, '');

  it('renders the decision error exactly once', () => {
    const occurrences = template.match(/<p class="sheet-error"/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('places it outside every prompt-kind branch, so no prompt can miss it', () => {
    const index = controlFlow.indexOf('@if (error())');
    expect(index).toBeGreaterThan(-1);

    const before = controlFlow.slice(0, index);
    const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    // 0 = top level of the template. Any branch nesting would make this >= 1.
    expect(depth).toBe(0);
  });

  it('still guards the render on there being an error', () => {
    expect(controlFlow).toContain('@if (error())');
  });
});
