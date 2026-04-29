import {
  type NlWorkflowSignal,
  type NlWorkflowSuggestion,
} from '../../shared/types/workflow.types';
import { getLogger } from '../logging/logger';

const FILE_REGEX = /(?:\b|^)([a-z0-9_./-]+\.[a-z]{1,5})\b/gi;
const CHILDREN_REGEX = /\b(\d+)\s+(?:children|agents|reviewers|verifiers|workers)\b/i;
const logger = getLogger('NlWorkflowClassifier');

export interface NlWorkflowClassifier {
  classify(text: string, context: { provider?: string; workingDirectory?: string }): NlWorkflowSuggestion;
}

const WORKFLOW_KEYWORDS: ReadonlyArray<{
  pattern: RegExp;
  signal: NlWorkflowSignal;
  suggestedRef: string;
}> = [
  { pattern: /\breview(?:\b|s|ing|ed)/i, signal: 'workflow-keyword-review', suggestedRef: 'pr-review' },
  { pattern: /\baudit(?:\b|s|ing|ed)/i, signal: 'workflow-keyword-audit', suggestedRef: 'repo-health-audit' },
  { pattern: /\brefactor(?:\b|s|ing|ed)/i, signal: 'workflow-keyword-refactor', suggestedRef: 'issue-implementation' },
  { pattern: /\bdebug(?:\b|s|ging|ged)/i, signal: 'workflow-keyword-debug', suggestedRef: 'issue-implementation' },
  { pattern: /\bfeature(?:\b|s)/i, signal: 'workflow-keyword-feature', suggestedRef: 'feature-development' },
];

class DefaultNlWorkflowClassifier implements NlWorkflowClassifier {
  classify(text: string): NlWorkflowSuggestion {
    const matchedSignals: NlWorkflowSignal[] = [];
    const fileMatches = [...text.matchAll(FILE_REGEX)].map(match => match[1]);
    const fileCount = new Set(fileMatches).size;
    if (fileCount > 1) {
      matchedSignals.push('mentions-multiple-files');
    }

    const childMatch = text.match(CHILDREN_REGEX);
    const childCount = childMatch ? Number.parseInt(childMatch[1] ?? '0', 10) : 0;
    if (childCount >= 3) {
      matchedSignals.push('mentions-three-or-more-children');
    }

    let suggestedRef: string | null = null;
    for (const keyword of WORKFLOW_KEYWORDS) {
      if (keyword.pattern.test(text)) {
        matchedSignals.push(keyword.signal);
        suggestedRef = keyword.suggestedRef;
      }
    }
    const hasWorkflowKeyword = WORKFLOW_KEYWORDS.some(keyword =>
      matchedSignals.includes(keyword.signal)
    );

    if (/\b(orchestrat\w+|spawn|child|agent)\b/i.test(text)) {
      matchedSignals.push('orchestration-mention');
    } else {
      matchedSignals.push('no-orchestration-mention');
    }

    const isLarge =
      childCount >= 3 ||
      (matchedSignals.includes('workflow-keyword-review') && fileCount > 1) ||
      (text.length > 1000 && hasWorkflowKeyword);
    const isMedium = !isLarge && (hasWorkflowKeyword || fileCount > 1);

    let suggestion: NlWorkflowSuggestion;
    if (isLarge) {
      suggestion = {
        size: 'large',
        surface: 'preflight-modal',
        suggestedRef,
        matchedSignals,
        estimatedChildCount: Math.max(childCount, 3),
        estimatedProviderImpact: 'medium',
      };
    } else if (isMedium) {
      suggestion = {
        size: 'medium',
        surface: 'template-confirm',
        suggestedRef,
        matchedSignals,
        estimatedProviderImpact: 'low',
      };
    } else {
      suggestion = {
        size: 'small',
        surface: 'slash-command',
        suggestedRef: '/explain',
        matchedSignals,
        estimatedProviderImpact: 'none',
      };
    }

    logger.info('nl-classifier.classified', {
      size: suggestion.size,
      surface: suggestion.surface,
      suggestedRef: suggestion.suggestedRef,
      signalCount: suggestion.matchedSignals.length,
    });
    return suggestion;
  }
}

let instance: NlWorkflowClassifier | null = null;

export function getNlWorkflowClassifier(): NlWorkflowClassifier {
  instance ??= new DefaultNlWorkflowClassifier();
  return instance;
}

export function _resetNlWorkflowClassifierForTesting(): void {
  instance = null;
}
