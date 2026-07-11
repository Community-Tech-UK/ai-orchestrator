import type {
  MobileAttachmentDto,
  MobileCreateInstanceRequest,
  MobileSessionPlan,
} from '../../core/models';

export interface StartSessionState {
  online: boolean;
  directory: string;
  busy: boolean;
}

export interface CreateInstanceInput {
  directory: string;
  provider: string;
  model: string | undefined;
  prompt: string;
  attachments: MobileAttachmentDto[];
}

export function providerDisplayName(provider: string): string {
  return provider
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toLocaleUpperCase() + part.slice(1))
    .join(' ');
}

export function sessionPlanSummary(plan: MobileSessionPlan | null): string {
  if (!plan) return 'Resolving session settings';
  return [plan.modelLabel || 'Default model', plan.reasoningEffortLabel]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

export function shouldPresentDirectorySheet(
  presetDirectory: string,
  directories: string[],
): boolean {
  return !presetDirectory && directories.length > 0;
}

export function canStartSession(state: StartSessionState): boolean {
  return state.online && state.directory.trim().length > 0 && !state.busy;
}

export function buildCreateInstanceRequest(
  input: CreateInstanceInput,
): MobileCreateInstanceRequest {
  const prompt = input.prompt.trim();
  return {
    workingDirectory: input.directory,
    provider: input.provider,
    model: input.model,
    initialPrompt: prompt || undefined,
    attachments: input.attachments.length ? input.attachments : undefined,
  };
}

export function newSessionSuccessRoute(
  workingDirectory: string,
  instanceId: string,
): string[] {
  return [
    '/projects',
    workingDirectory || '__no_workspace__',
    'sessions',
    instanceId,
  ];
}
