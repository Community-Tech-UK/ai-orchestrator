import type {
  BashValidationResult, BashValidatorSubmodule, CommandIntent, EvasionFlags,
  ParsedCommand, SubmoduleResult, ValidationContext,
} from './types';
import { defaultValidationContext, emptyEvasionFlags } from './types';
import { CommandParser } from './command-parser';
import { IntentClassifier } from './intent-classifier';
import { EvasionDetector } from './validators/evasion-detector';
import { DestructiveValidator } from './validators/destructive-validator';
import { ModeValidator } from './validators/mode-validator';
import { GitValidator } from './validators/git-validator';
import { SedValidator } from './validators/sed-validator';
import { NetworkValidator } from './validators/network-validator';
import { DockerValidator } from './validators/docker-validator';
import { PackageValidator } from './validators/package-validator';
import { PathValidator } from './validators/path-validator';

const MAX_COMMAND_LENGTH = 10_000;

export class BashValidationPipeline {
  private parser = new CommandParser();
  private classifier = new IntentClassifier();
  private evasionDetector = new EvasionDetector();

  private submodules: BashValidatorSubmodule[] = [
    new DestructiveValidator(),
    new ModeValidator(),
    new GitValidator(),
    new SedValidator(),
    new NetworkValidator(),
    new DockerValidator(),
    new PackageValidator(),
    new PathValidator(),
  ];

  validate(command: string, context?: ValidationContext): BashValidationResult {
    const ctx = context ?? defaultValidationContext();
    const trimmed = command.trim();

    if (!trimmed) {
      return this.buildResult(trimmed, 'blocked', 'Empty command', 'unknown', emptyEvasionFlags(), []);
    }

    if (trimmed.length > MAX_COMMAND_LENGTH) {
      return this.buildResult(trimmed, 'blocked', `Command exceeds max length of ${MAX_COMMAND_LENGTH}`, 'unknown', emptyEvasionFlags(), []);
    }

    const parsed = this.parser.parse(trimmed);
    const evasionFlags = this.evasionDetector.detectFlags(trimmed);
    const evasionResult = this.evasionDetector.validate(trimmed);
    const intent = this.classifier.classify(parsed.segments);

    const allResults: SubmoduleResult[] = [];

    if (evasionResult.action !== 'allow') {
      allResults.push(evasionResult);
    }

    // Privilege escalation checks (for backward compat with sudo -i, sudo su)
    if (/\b(sudo\s+(-i|-s)\b|sudo\s+su\b)/.test(trimmed)) {
      allResults.push({ action: 'warn', message: 'Interactive privilege escalation', submodule: 'pipeline' });
    }

    // Run each submodule — short-circuit on first Block
    if (evasionResult.action !== 'block') {
      for (const submodule of this.submodules) {
        const result = submodule.validate(trimmed, parsed, ctx);
        if (result.action !== 'allow') {
          allResults.push(result);
          if (result.action === 'block') break;
        }
      }
    }

    return this.computeResult(trimmed, intent, evasionFlags, allResults, parsed);
  }

  private computeResult(
    command: string,
    intent: CommandIntent,
    evasionFlags: EvasionFlags,
    results: SubmoduleResult[],
    parsed: ParsedCommand,
  ): BashValidationResult {
    const blocks = results.filter((r): r is Extract<SubmoduleResult, { action: 'block' }> => r.action === 'block');
    const warns = results.filter((r): r is Extract<SubmoduleResult, { action: 'warn' }> => r.action === 'warn');

    let risk: BashValidationResult['risk'];
    let valid: boolean;
    let message: string | undefined;

    if (blocks.length > 0) {
      risk = 'blocked';
      valid = false;
      message = blocks[0].reason;
    } else if (warns.length > 0) {
      risk = 'warning';
      valid = true;
      message = warns.map(w => w.message).join('; ');
    } else {
      risk = 'safe';
      valid = true;
    }

    const firstSeg = parsed.segments[0];
    const details = firstSeg ? {
      mainCommand: firstSeg.mainCommand,
      arguments: firstSeg.arguments,
      pipes: firstSeg.pipes,
      redirects: firstSeg.redirects,
      warnings: warns.map(w => w.message),
      blockedPatterns: blocks.map(b => b.reason),
    } : {
      mainCommand: '',
      arguments: [],
      pipes: [],
      redirects: [],
      warnings: warns.map(w => w.message),
      blockedPatterns: blocks.map(b => b.reason),
    };

    return {
      valid,
      risk,
      message,
      command,
      intent,
      evasionFlags,
      submoduleResults: results,
      details,
    };
  }

  private buildResult(
    command: string,
    risk: BashValidationResult['risk'],
    message: string,
    intent: CommandIntent,
    evasionFlags: EvasionFlags,
    submoduleResults: SubmoduleResult[],
  ): BashValidationResult {
    return {
      valid: risk !== 'blocked',
      risk,
      message,
      command,
      intent,
      evasionFlags,
      submoduleResults,
    };
  }
}

// Singleton
let pipeline: BashValidationPipeline | null = null;

export function getBashValidationPipeline(): BashValidationPipeline {
  if (!pipeline) {
    pipeline = new BashValidationPipeline();
  }
  return pipeline;
}

export function _resetBashValidationPipelineForTesting(): void {
  pipeline = null;
}
