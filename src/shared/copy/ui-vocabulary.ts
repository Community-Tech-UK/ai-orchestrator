/** Vocabulary projections. Author names, definitions and migration rules in the glossary. */
import { GLOSSARY, type GlossaryEntry } from '../glossary/glossary';

export const PRODUCT_NAME = GLOSSARY.product.label;
export const APP_NAME_PATTERN = GLOSSARY.product.vocabulary.never[0];

export interface UiTerm {
  readonly id: string;
  readonly use: string;
  readonly never: readonly RegExp[];
  readonly meaning: string;
  readonly enforcement: 'zero' | 'ratchet' | 'planned';
  readonly owner?: string;
}

export const UI_TERMS: readonly UiTerm[] = (Object.entries(GLOSSARY) as [string, GlossaryEntry][])
  .flatMap(([id, entry]) => entry.vocabulary ? [{
    id,
    use: entry.label,
    meaning: entry.plain,
    ...entry.vocabulary,
  }] : []);
