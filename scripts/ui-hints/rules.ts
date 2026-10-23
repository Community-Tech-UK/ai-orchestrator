import ts from 'typescript';
import { relative } from 'node:path';
import { EXEMPT_REASONS, RULE_CODES, SHORTCUT_PATTERN, TITLE_EXCEPTIONS, WORD, normalizePath, type ElementFact, type RuleCode, type Violation, type Collection } from './types';
import { HOVER_ONLY_REASONS } from './hover-only-reasons';

const guide = ' See docs/screen-and-wording-guide.md, section 5.';
export const RULE_CATALOGUE: Record<RuleCode, { title: string; fix: string; status: string }> = Object.fromEntries([
  ['H1a', 'Icon control has no accessible name', 'Give the control an aria-label with a word.'],
  ['H1b', 'Icon control has no Harness tooltip', 'Add appTooltip or appIconButton.'],
  ['H1c', 'Name and tooltip disagree', 'Begin the tooltip with the accessible name.'],
  ['H2a', 'Native title on a control', 'Move the unchanged words into appTooltip.'],
  ['H2b', 'Native title on a plain element', 'Move the unchanged words into an accessible tooltip.'],
  ['H2c', 'Title on a component host', 'Rename the component input.'],
  ['H3', 'Nested hover hosts', 'Use one hover host.'],
  ['H4', 'Hover-only host needs a reason', 'Make the hint reachable or record its exact reason.'],
  ['H5', 'Hard-coded shortcut', 'Use appTooltipShortcut or a local-key marker.'],
  ['H6', 'Unused TOOLTIP_COPY key', 'Remove the unused key or wire its actual use.'],
  ['H7', 'Lasting disabled control without a reason', 'Add appTooltipDisabledReason.'],
  ['H8', 'First glossary use is unmarked', 'Use app-term for its first occurrence.'],
  ['H9', 'Recorded hover wording lost', 'Keep the words in a hover or visible text, or --retire with --reason.'],
  ['H10', 'Clickable non-control without a role', 'Use a real control or supply a role and keyboard handling.'],
  ['H11', 'Hover outside templates', 'Move authored hover text into an analysed template.'],
  ['H12', 'Measurement or exemption integrity', 'Fix the unreadable template, inert directive, or stale exemption.'],
].map(([code, title, fix]) => [code, { title, fix: fix + (code !== 'H6' && code !== 'H7' && code !== 'H8' && code !== 'H12' ? guide : ''), status: (RULE_CODES as readonly string[]).includes(code!) ? 'ratchet' : code === 'H9' || code === 'H12' ? 'hard' : 'report' }])) as Record<RuleCode, { title: string; fix: string; status: string }>;
export const reasonKey = (fact: ElementFact): string => `${fact.ownerFile}#${fact.tag}.${fact.firstClass}`;
export function evaluateFacts(facts: ElementFact[], reasons: Record<string, string> = HOVER_ONLY_REASONS): Violation[] {
  const violations: Violation[] = [];
  const usedReasons = new Set<string>();
  for (const fact of facts) {
    const add = (code: RuleCode, message = RULE_CATALOGUE[code].title): void => { violations.push({ code, ownerFile: fact.ownerFile, file: fact.file, line: fact.line, message }); };
    const eligible: RuleCode[] = [];
    if (fact.iconOnly && !fact.hidden) {
      if (!fact.name) eligible.push('H1a');
      else if (!fact.tooltip) eligible.push('H1b');
    }
    if (fact.title && !(TITLE_EXCEPTIONS as readonly string[]).includes(fact.tag)) eligible.push(fact.componentHost ? 'H2c' : fact.control ? 'H2a' : 'H2b');
    if ((fact.title || fact.tooltip) && fact.nested) eligible.push('H3');
    if ((fact.title || fact.tooltip) && !fact.control && !fact.focusable && !fact.name && !fact.componentHost) {
      const reason = reasonKey(fact);
      if (reasons[reason]) usedReasons.add(reason); else eligible.push('H4');
    }
    if (fact.hover.some(hover => hover.fragments.some(fragment => SHORTCUT_PATTERN.test(fragment)))) eligible.push('H5');
    if (fact.click && !fact.control && !fact.componentHost && !fact.role && fact.click.replace(/\$event\.(?:stopPropagation|preventDefault)\(\)\s*;?/g, '').trim()) eligible.push('H10');
    const suppressible = fact.marker === 'local-key' ? ['H5'] : ['H1a', 'H1b', 'H4', 'H10'];
    if (fact.marker) {
      if (!(EXEMPT_REASONS as readonly string[]).includes(fact.marker)) add('H12', `unknown marker ${fact.marker}`);
      else if (!eligible.some(code => suppressible.includes(code))) add('H12', `unused marker ${fact.marker}`);
    }
    for (const code of eligible) if (!fact.marker || !(EXEMPT_REASONS as readonly string[]).includes(fact.marker) || !suppressible.includes(code)) add(code);
    for (const inert of fact.inert) add('H12', `inert ${inert}: owning component must import ${inert === 'appIconButton' ? 'AppIconButtonDirective' : 'AioTooltipDirective'}`);
    const name = fact.attributes.find(attr => attr.name === 'aria-label')?.text;
    const tooltip = fact.attributes.find(attr => ['appTooltip', 'appIconButton'].includes(attr.name))?.text;
    if (name && WORD.test(name) && tooltip && !tooltip.toLocaleLowerCase().startsWith(name.toLocaleLowerCase())) add('H1c');
    if (fact.control && fact.disabled && !/busy|loading|saving|submitting|pending|running|sending|working|starting|stopping|processing|waiting|generating|applying|deleting|installing|uploading|downloading|connecting/i.test(fact.disabled) && !fact.tooltip && !fact.title && !fact.attributes.some(attr => attr.name === 'aria-describedby')) add('H7');
  }
  for (const key of Object.keys(reasons)) if (!usedReasons.has(key)) {
    const ownerFile = key.split('#')[0]!;
    violations.push({ code: 'H12', ownerFile, file: ownerFile, line: 1, message: 'stale hover-only reason: ' + key });
  }
  return violations;
}
export function findDeadCopyKeys(root: string, collection: Collection, keys: Record<string, string>, owners: Record<string, string>): Violation[] {
  const literals = new Set<string>();
  for (const file of collection.sourceFiles.filter(file => !/(?:^|\/)tooltip-copy[^/]*\.ts$/.test(file.fileName))) {
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  for (const template of collection.templates) for (const match of template.text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/(['"])([^'"\n]+)\1/g)) literals.add(match[2]!);
  return Object.keys(keys).filter(key => !literals.has(key)).map(key => {
    const ownerFile = normalizePath(relative(root, owners[key]!));
    return { code: 'H6', ownerFile, file: ownerFile, line: 1, message: 'unused copy key: ' + key };
  });
}
