import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { collectTemplates } from './template-sources';
import { parseFacts } from './template-facts';
import { readCopyRegistry } from './copy-registry';
import { evaluateFacts, findDeadCopyKeys } from './rules';
import { outsideTemplate } from './outside-template';
import { HOVER_ONLY_REASONS } from './hover-only-reasons';
import { TEXT_GAP, type Analysis } from './types';
import { glossaryReports } from './glossary-report';
import { GLOSSARY_PATTERNS } from '../../src/renderer/app/shared/glossary/glossary';

export function analyze(root: string, reasons?: Record<string, string>): Analysis {
  const hoverReasons = reasons ?? (existsSync(join(root, 'scripts/ui-hints/hover-only-reasons.ts')) ? HOVER_ONLY_REASONS : {});
  const collection = collectTemplates(root);
  const registry = readCopyRegistry(collection.sourceFiles);
  const analysis: Analysis = { collection, facts: [], violations: [...collection.errors], outside: [], streams: {}, copyKeys: registry.keys, counts: {} };
  for (const source of collection.templates) {
    try {
      const parsed = parseFacts(source, collection.sourceFiles, registry.keys);
      analysis.facts.push(...parsed.facts);
      analysis.streams[source.ownerFile] = [...(analysis.streams[source.ownerFile] ?? []), ...parsed.facts.flatMap(fact => fact.hover.flatMap(hover => hover.fragments.flatMap(fragment => [fragment, TEXT_GAP]))), ...parsed.visible];
      const stripped = source.text.replace(/<!--[\s\S]*?-->/g, '');
      const tags = stripped.match(/<[\w:-]+\b(?:"[^"]*"|'[^']*'|[^'">])*>/g) ?? [];
      const regexTitles = tags.filter(tag => /\s(?:title|\[title\]|\[attr.title\])\s*=/.test(tag)).length;
      const regexTooltips = tags.filter(tag => /\s(?:appTooltip|\[appTooltip\]|appTooltipTpl|\[appTooltipTpl\]|appIconButton|\[appIconButton\]|appTooltipDisabledReason|\[appTooltipDisabledReason\])(?:\s*=|\s|>)/.test(tag)).length;
      const astTitles = parsed.facts.filter(fact => fact.title).length;
      const astTooltips = parsed.facts.filter(fact => fact.attributes.some(attr => ['appTooltip', 'appTooltipTpl', 'appIconButton', 'appTooltipDisabledReason'].includes(attr.name))).length;
      if (regexTitles !== astTitles || regexTooltips !== astTooltips) analysis.violations.push({ code: 'H12', ownerFile: source.ownerFile, file: source.file, line: source.firstLine, message: `measurement drift: title ${astTitles}/${regexTitles}; tooltip ${astTooltips}/${regexTooltips}` });
    } catch (error) {
      analysis.violations.push({ code: 'H12', ownerFile: source.ownerFile, file: source.file, line: source.firstLine, message: String(error) });
    }
  }
  analysis.violations.push(...glossaryReports(collection, GLOSSARY_PATTERNS));
  analysis.outside = outsideTemplate(root, collection);
  analysis.violations.push(...evaluateFacts(analysis.facts, hoverReasons), ...findDeadCopyKeys(root, collection, registry.keys, registry.owners), ...analysis.outside);
  analysis.counts = {
    templates: collection.templates.length, components: collection.componentCount, elements: analysis.facts.length,
    controls: analysis.facts.filter(fact => fact.control).length,
    iconOnly: analysis.facts.filter(fact => fact.iconOnly).length,
    namedByText: analysis.facts.filter(fact => fact.control && fact.visible.some(text => /\p{L}{2,}/u.test(text))).length,
    namedByData: analysis.facts.filter(fact => fact.control && (fact.dataText || fact.dataName) && !fact.visible.some(text => /\p{L}{2,}/u.test(text))).length,
    opaque: analysis.facts.filter(fact => fact.control && fact.opaque && !fact.dataText && !fact.visible.some(text => /\p{L}{2,}/u.test(text))).length,
    unnamedFields: analysis.facts.filter(fact => fact.field && !fact.name).length,
    titles: analysis.facts.filter(fact => fact.title).length,
    tooltips: analysis.facts.filter(fact => fact.tooltip).length,
    inert: analysis.facts.filter(fact => fact.inert.length).length,
    outside: analysis.outside.length,
    markers: analysis.facts.filter(fact => fact.marker).length,
    unreadable: analysis.facts.reduce((sum, fact) => sum + fact.hover.filter(hover => hover.unreadable).length, 0),
  };
  return analysis;
}
