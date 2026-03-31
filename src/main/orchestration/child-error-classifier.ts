/**
 * Child Error Classifier - Classifies child instance errors into actionable categories
 *
 * Inspired by CodePilot's error-classifier.ts and Codex's error.rs.
 * Categorizes errors from child instances to help parents decide whether to
 * retry, switch providers, or escalate.
 */

import { getLogger } from '../logging/logger';
import type { ChildErrorClassification, ChildErrorCategory } from '../../shared/types/child-announce.types';

const logger = getLogger('ChildErrorClassifier');

interface ErrorPattern {
  patterns: RegExp[];
  category: ChildErrorCategory;
  retryable: boolean;
  suggestedAction: ChildErrorClassification['suggestedAction'];
  userMessage: (match: string) => string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    patterns: [
      /timed?\s*out/i,
      /timeout/i,
      /ETIMEDOUT/i,
      /deadline exceeded/i,
    ],
    category: 'timeout',
    retryable: true,
    suggestedAction: 'retry',
    userMessage: () => 'Child instance timed out. May succeed on retry.',
  },
  {
    patterns: [
      /context.?length.?exceeded/i,
      /token.?limit/i,
      /context.?overflow/i,
      /maximum.?context/i,
      /too many tokens/i,
    ],
    category: 'context_overflow',
    retryable: true,
    suggestedAction: 'retry_different_model',
    userMessage: () => 'Child ran out of context window. Try with a larger-context model.',
  },
  {
    patterns: [
      /429/,
      /too many requests/i,
      /rate.?limit/i,
      /quota.?exceeded/i,
      /throttl/i,
    ],
    category: 'rate_limited',
    retryable: true,
    suggestedAction: 'retry_different_provider',
    userMessage: () => 'Provider rate limited. Try a different provider or wait.',
  },
  {
    patterns: [
      /401/,
      /403/,
      /unauthorized/i,
      /invalid.?api.?key/i,
      /authentication/i,
      /not.?authenticated/i,
    ],
    category: 'auth_failure',
    retryable: false,
    suggestedAction: 'escalate_to_user',
    userMessage: () => 'Authentication failed. Check API keys/credentials.',
  },
  {
    patterns: [
      /ECONNREFUSED/i,
      /ECONNRESET/i,
      /ENOTFOUND/i,
      /socket hang up/i,
      /network.?error/i,
      /fetch failed/i,
    ],
    category: 'network_error',
    retryable: true,
    suggestedAction: 'retry',
    userMessage: () => 'Network connectivity issue. May resolve on retry.',
  },
  {
    patterns: [
      /exited with code [1-9]/i,
      /process.?crash/i,
      /SIGKILL/i,
      /SIGTERM/i,
      /SIGSEGV/i,
      /killed/i,
    ],
    category: 'process_crash',
    retryable: true,
    suggestedAction: 'retry',
    userMessage: () => 'Child process crashed unexpectedly. May succeed on retry.',
  },
  {
    patterns: [
      /task failed/i,
      /tests? (?:did not|didn't) pass/i,
      /build failed/i,
      /compilation failed/i,
    ],
    category: 'task_failure',
    retryable: true,
    suggestedAction: 'retry',
    userMessage: (match: string) => `Child reported failure: ${match.slice(0, 200)}`,
  },
];

export class ChildErrorClassifier {
  private static instance: ChildErrorClassifier | null = null;

  private constructor() {}

  static getInstance(): ChildErrorClassifier {
    if (!this.instance) {
      this.instance = new ChildErrorClassifier();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Classify an error from a child instance.
   *
   * @param errorMessage - The error text (stderr, error event, or status message)
   * @param instanceStatus - The instance's status when the error occurred
   * @param wasStuck - Whether StuckProcessDetector flagged this instance
   */
  classify(
    errorMessage: string,
    instanceStatus: string,
    wasStuck = false,
  ): ChildErrorClassification {
    // Special case: stuck detection takes priority
    if (wasStuck) {
      return {
        category: 'stuck',
        userMessage: 'Child instance was detected as stuck (no progress).',
        retryable: true,
        suggestedAction: 'retry',
        rawError: errorMessage,
      };
    }

    // Match against known patterns
    for (const pattern of ERROR_PATTERNS) {
      for (const regex of pattern.patterns) {
        if (regex.test(errorMessage)) {
          return {
            category: pattern.category,
            userMessage: pattern.userMessage(errorMessage),
            retryable: pattern.retryable,
            suggestedAction: pattern.suggestedAction,
            rawError: errorMessage,
          };
        }
      }
    }

    // Unknown error
    logger.warn('Unclassified child error', { errorMessage, instanceStatus });
    return {
      category: 'unknown',
      userMessage: `Unclassified error: ${errorMessage.slice(0, 200)}`,
      retryable: false,
      suggestedAction: 'escalate_to_user',
      rawError: errorMessage,
    };
  }
}

export function getChildErrorClassifier(): ChildErrorClassifier {
  return ChildErrorClassifier.getInstance();
}
