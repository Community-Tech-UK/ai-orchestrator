import { CLAUDE_LEGACY_PRICING_ALIASES, MODEL_PRICING } from '../../shared/types/provider.types';
import type { ModelFamily } from './token-counter';

export const MODEL_PATTERNS = {
  'gpt-4': {
    avgCharsPerToken: 3.5,
    codeMultiplier: 0.85,
    whitespaceWeight: 0.3,
  },
  'gpt-3.5': {
    avgCharsPerToken: 3.5,
    codeMultiplier: 0.85,
    whitespaceWeight: 0.3,
  },
  claude: {
    avgCharsPerToken: 3.8,
    codeMultiplier: 0.9,
    whitespaceWeight: 0.25,
  },
  llama: {
    avgCharsPerToken: 3.2,
    codeMultiplier: 0.95,
    whitespaceWeight: 0.35,
  },
  unknown: {
    avgCharsPerToken: 4.0,
    codeMultiplier: 1.0,
    whitespaceWeight: 0.3,
  },
} as const;

const LEGACY_PRICING: readonly (readonly [string, { input: number; output: number }])[] = [
  [CLAUDE_LEGACY_PRICING_ALIASES.SONNET_35, { input: 3.0, output: 15.0 }],
  [CLAUDE_LEGACY_PRICING_ALIASES.HAIKU_35, { input: 0.8, output: 4.0 }],
  [CLAUDE_LEGACY_PRICING_ALIASES.OPUS_3, { input: 15.0, output: 75.0 }],
  [CLAUDE_LEGACY_PRICING_ALIASES.SONNET_3, { input: 3.0, output: 15.0 }],
  [CLAUDE_LEGACY_PRICING_ALIASES.HAIKU_3, { input: 0.25, output: 1.25 }],
  ['gpt-4', { input: 30.0, output: 60.0 }],
  ['gpt-3.5', { input: 0.5, output: 1.5 }],
];

const PRICING_ENTRIES_BY_SPECIFICITY = Object.entries(MODEL_PRICING)
  .map(([k, v]) => [k.toLowerCase(), v] as const)
  .sort((a, b) => b[0].length - a[0].length);

export function isLikelyCode(text: string): boolean {
  const codeIndicators = [
    /^(import|export|const|let|var|function|class|interface|type)\s/m,
    /[{}[\]();]/,
    /^\s*(\/\/|\/\*|\*|#)/m,
    /=>/,
    /\.\w+\(/,
    /:\s*(string|number|boolean|void|any|unknown)/,
  ];

  const matchCount = codeIndicators.filter((pattern) => pattern.test(text)).length;
  return matchCount >= 2;
}

export function countSpecialTokens(text: string): number {
  const newlines = (text.match(/\n/g) || []).length;
  const specialPunct = (text.match(/[{}()[\]<>]/g) || []).length;

  return Math.floor(newlines * 0.5 + specialPunct * 0.3);
}

export function getModelFamily(model?: string): ModelFamily {
  if (!model) return 'unknown';

  const lowerModel = model.toLowerCase();

  if (lowerModel.includes('gpt-4') || lowerModel.includes('gpt4')) {
    return 'gpt-4';
  }
  if (lowerModel.includes('gpt-3.5') || lowerModel.includes('gpt35') || lowerModel.includes('turbo')) {
    return 'gpt-3.5';
  }
  if (lowerModel.includes('claude') || lowerModel.includes('anthropic')) {
    return 'claude';
  }
  if (lowerModel.includes('llama') || lowerModel.includes('mistral') || lowerModel.includes('vicuna')) {
    return 'llama';
  }

  return 'unknown';
}

export function lookupPricing(model?: string): { input: number; output: number } {
  const lowerModel = (model || '').toLowerCase();
  if (!lowerModel) return { input: 0, output: 0 };

  const exact = MODEL_PRICING[lowerModel];
  if (exact) return exact;

  for (const [legacyKey, pricing] of LEGACY_PRICING) {
    if (lowerModel.includes(legacyKey)) return pricing;
  }

  for (const [key, pricing] of PRICING_ENTRIES_BY_SPECIFICITY) {
    if (lowerModel.includes(key)) return pricing;
  }

  return { input: 0, output: 0 };
}
