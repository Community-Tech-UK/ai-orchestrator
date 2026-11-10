import { describe, expect, it } from 'vitest';
import { UI_TERMS } from '../../../../shared/copy/ui-vocabulary';
import { CONTROL_SURFACES } from '../control-surface/control-surface.registry';
import { CONTROL_SURFACE_HELP } from '../help/control-surface-help';
import { GLOSSARY, GLOSSARY_PATTERNS, type GlossaryEntry } from '../../../../shared/glossary/glossary';

describe('Glossary', () => {
  it('supplies every vocabulary mapping from the authored glossary entry', () => {
    for (const term of UI_TERMS) {
      const entry = (GLOSSARY as Record<string, GlossaryEntry>)[term.id];
      expect(entry, term.id).toBeDefined();
      expect(term.use).toBe(entry.label);
      expect(term.meaning).toBe(entry.plain);
    }
  });
  it('has useful, unambiguous entries including every canonical vocabulary term', () => {
    expect(Object.keys(GLOSSARY)).toHaveLength(48);
    const names = new Set<string>();
    for (const entry of Object.values(GLOSSARY) as GlossaryEntry[]) {
      expect(entry.plain.trim().length).toBeGreaterThan(0);
      expect(entry.plain.split(/\s+/).length).toBeLessThanOrEqual(30);
      expect(entry.group.trim().length).toBeGreaterThan(0);
      if (entry.term) expect(UI_TERMS.some(term => term.id === entry.term)).toBe(true);
      for (const term of UI_TERMS) {
        for (const pattern of term.never) {
          expect(pattern.global || pattern.sticky).toBe(false);
          expect(`${entry.label} ${entry.plain}`, term.id).not.toMatch(pattern);
        }
      }
      for (const name of [entry.label, ...(entry.aliases ?? [])]) {
        expect(names.has(name.toLowerCase()), name).toBe(false);
        names.add(name.toLowerCase());
      }
      if (entry.learnMore && entry.learnMore.surface) {
        const surface = entry.learnMore.surface as keyof typeof CONTROL_SURFACE_HELP;
        expect(CONTROL_SURFACES.some(candidate => candidate.id === surface)).toBe(true);
        expect(CONTROL_SURFACE_HELP[surface]).toBeDefined();
      }
    }
  });

  it('expands acronyms and keeps patterns stateless', () => {
    expect(GLOSSARY.rtk.plain).toContain('Rust Token Killer (RTK)');
    expect(GLOSSARY['tool-servers'].plain).toContain('Model Context Protocol');
    expect(GLOSSARY['code-intelligence'].plain).toContain('Language Server Protocol');
    expect(GLOSSARY.acp.plain).toContain('Agent Client Protocol');
    for (const { pattern } of GLOSSARY_PATTERNS) expect(pattern.global || pattern.sticky).toBe(false);
  });
});
