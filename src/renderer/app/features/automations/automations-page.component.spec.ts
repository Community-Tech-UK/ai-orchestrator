import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(resolve(specDirectory, './automations-page.component.ts'), 'utf8');
const templateSource = readFileSync(resolve(specDirectory, './automations-page.component.html'), 'utf8');

describe('AutomationsPageComponent route header', () => {
  it('uses the shared PageHeaderComponent for the page title and dashboard Back control', () => {
    expect(componentSource).toContain('PageHeaderComponent');
    expect(templateSource).toContain('<app-page-header');
    expect(templateSource).toContain('title="Automations"');
    expect(templateSource).toContain('backRoute="/"');
    expect(templateSource).not.toContain('<header class="toolbar">');
  });
});
