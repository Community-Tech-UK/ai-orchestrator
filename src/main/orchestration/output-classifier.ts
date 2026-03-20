import type { ReviewOutputType } from '../../shared/types/cross-model-review.types';

export type ClassificationType = ReviewOutputType | 'conversation';

export interface OutputClassification {
  type: ClassificationType;
  shouldReview: boolean;
  isComplex: boolean;
  complexityReasons: string[];
  codeLineCount: number;
  fileCount: number;
  stepCount: number;
}

const MIN_OUTPUT_LENGTH = 50;

const CODE_FENCE_REGEX = /```[\w]*\n([\s\S]*?)```/g;
const NUMBERED_STEP_REGEX = /^\s*\d+\.\s+/gm;
const FILE_TOUCH_REGEX = /(?:create|modify|edit|write|update)\s+`?[\w/.\\-]+\.[a-z]+`?/gi;

const COMPLEXITY_KEYWORDS = [
  'security', 'auth', 'authentication', 'authorization',
  'migration', 'database schema', 'breaking change',
  'encryption', 'password', 'secret', 'credential',
  'sql injection', 'xss', 'csrf',
];

const ARCHITECTURE_KEYWORDS = [
  'system design', 'data flow', 'component diagram',
  'architecture', 'service mesh', 'microservice',
  'load balancer', 'message queue', 'event bus',
];

const PLAN_KEYWORDS = [
  'implementation plan', 'action plan', 'migration plan',
  'step-by-step', 'phases:', 'milestones:',
];

export class OutputClassifier {
  classify(content: string): OutputClassification {
    const result: OutputClassification = {
      type: 'conversation',
      shouldReview: false,
      isComplex: false,
      complexityReasons: [],
      codeLineCount: 0,
      fileCount: 0,
      stepCount: 0,
    };

    if (content.length < MIN_OUTPUT_LENGTH) {
      return result;
    }

    const lowerContent = content.toLowerCase();

    const codeBlocks = [...content.matchAll(CODE_FENCE_REGEX)];
    result.codeLineCount = codeBlocks.reduce((sum, match) => sum + match[1].split('\n').length, 0);

    const steps = content.match(NUMBERED_STEP_REGEX);
    result.stepCount = steps?.length ?? 0;

    const fileTouches = content.match(FILE_TOUCH_REGEX);
    result.fileCount = fileTouches?.length ?? 0;

    if (this.isArchitecture(lowerContent)) {
      result.type = 'architecture';
      result.shouldReview = true;
      result.isComplex = true;
      result.complexityReasons.push('architecture output');
    } else if (this.isPlan(lowerContent, result.stepCount)) {
      result.type = 'plan';
      result.shouldReview = true;
    } else if (result.codeLineCount > 0) {
      result.type = 'code';
      result.shouldReview = true;
    }

    if (result.type !== 'architecture' && result.shouldReview) {
      if (result.codeLineCount > 100) {
        result.isComplex = true;
        result.complexityReasons.push(`${result.codeLineCount} lines of code`);
      }
      if (result.fileCount > 3) {
        result.isComplex = true;
        result.complexityReasons.push(`${result.fileCount} files touched`);
      }
      if (result.stepCount > 5) {
        result.isComplex = true;
        result.complexityReasons.push(`${result.stepCount} plan steps`);
      }

      for (const keyword of COMPLEXITY_KEYWORDS) {
        if (lowerContent.includes(keyword)) {
          result.isComplex = true;
          result.complexityReasons.push(`contains "${keyword}"`);
          break;
        }
      }
    }

    return result;
  }

  private isArchitecture(lowerContent: string): boolean {
    return ARCHITECTURE_KEYWORDS.some(kw => lowerContent.includes(kw));
  }

  private isPlan(lowerContent: string, stepCount: number): boolean {
    if (stepCount >= 3 && PLAN_KEYWORDS.some(kw => lowerContent.includes(kw))) {
      return true;
    }
    return stepCount >= 5;
  }
}
