import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** The Context details popover embeds the evidence panel, whose template is a separate file. */
export function resolveContextEvidenceTemplate(): Promise<void> {
  return resolveComponentResources(async (url: string) => url.endsWith('context-evidence-panel.component.html')
    ? readFileSync(join(__dirname, '../../shared/components/context-evidence-panel', basename(url)), 'utf8') : '');
}
