import type {
  CommandApplicability,
  CommandTemplate,
} from '../types/command.types';
import type { InstanceProvider, InstanceStatus } from '../types/instance.types';

export interface CommandContext {
  provider?: InstanceProvider;
  instanceStatus?: InstanceStatus;
  workingDirectory?: string | null;
  isGitRepo?: boolean;
  featureFlags?: Record<string, boolean>;
}

export interface ApplicabilityResult {
  eligible: boolean;
  reason?: string;
  failedPredicate?: 'provider' | 'instanceStatus' | 'workingDirectory' | 'gitRepo' | 'featureFlag';
}

function values<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) return 'unknown';
  return items.join(', ');
}

function fail(
  command: Pick<CommandTemplate, 'disabledReason'>,
  failedPredicate: ApplicabilityResult['failedPredicate'],
  reason: string,
): ApplicabilityResult {
  return {
    eligible: false,
    failedPredicate,
    reason: command.disabledReason || reason,
  };
}

export function evaluateApplicability(
  command: Pick<CommandTemplate, 'applicability' | 'disabledReason'>,
  context: CommandContext,
): ApplicabilityResult {
  const applicability: CommandApplicability | undefined = command.applicability;
  if (!applicability) {
    return { eligible: true };
  }

  const expectedProviders = values(applicability.provider);
  if (
    expectedProviders.length > 0 &&
    (!context.provider || !expectedProviders.includes(context.provider))
  ) {
    return fail(
      command,
      'provider',
      `Only available with ${formatList(expectedProviders)} (current: ${context.provider ?? 'none'})`,
    );
  }

  const expectedStatuses = values(applicability.instanceStatus);
  if (
    expectedStatuses.length > 0 &&
    (!context.instanceStatus || !expectedStatuses.includes(context.instanceStatus))
  ) {
    return fail(
      command,
      'instanceStatus',
      `Only available while ${formatList(expectedStatuses)} (current: ${context.instanceStatus ?? 'none'})`,
    );
  }

  if (applicability.requiresWorkingDirectory && !context.workingDirectory) {
    return fail(command, 'workingDirectory', 'Requires a working directory');
  }

  if (
    applicability.requiresGitRepo &&
    context.workingDirectory &&
    context.isGitRepo === false
  ) {
    return fail(command, 'gitRepo', 'Requires a git repository');
  }

  if (
    applicability.featureFlag &&
    context.featureFlags?.[applicability.featureFlag] !== true
  ) {
    return fail(command, 'featureFlag', `Requires the ${applicability.featureFlag} setting`);
  }

  return { eligible: true };
}
