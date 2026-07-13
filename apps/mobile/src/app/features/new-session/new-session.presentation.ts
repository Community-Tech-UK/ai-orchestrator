import type {
  MobileAttachmentDto,
  MobileCreateInstanceRequest,
  MobileReasoningEffort,
  MobileReasoningOption,
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
  reasoningEffort: MobileReasoningEffort | undefined;
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

export function defaultReasoningEffortForProvider(
  provider: string,
): MobileReasoningEffort | undefined {
  return provider === 'claude' || provider === 'codex' || provider === 'grok'
    ? 'high'
    : undefined;
}

export function reasoningOptionsForProvider(provider: string): MobileReasoningOption[] {
  const markDefault = (options: MobileReasoningOption[]): MobileReasoningOption[] =>
    options.map((option) =>
      option.id === defaultReasoningEffortForProvider(provider)
        ? { ...option, isDefault: true }
        : option,
    );

  if (provider === 'claude') {
    return markDefault([
      { id: 'low', label: 'Low', description: 'Shorter thinking' },
      { id: 'medium', label: 'Medium', description: 'Balanced thinking' },
      { id: 'high', label: 'High', description: "Claude's standard depth" },
      { id: 'xhigh', label: 'Extra', description: 'Deeper reasoning' },
      { id: 'max', label: 'Max', description: 'Deepest session-only reasoning' },
      { id: 'workflow', label: 'Workflow', description: 'Claude Code ultracode mode' },
    ]);
  }

  if (provider === 'codex') {
    return markDefault([
      { id: 'default', label: 'Provider', description: 'Let the provider decide' },
      { id: 'none', label: 'Off', description: 'No extra reasoning effort' },
      { id: 'minimal', label: 'Minimal', description: 'Light reasoning' },
      { id: 'low', label: 'Low', description: 'Shorter thinking' },
      { id: 'medium', label: 'Medium', description: 'Balanced thinking' },
      { id: 'high', label: 'High', description: 'Deeper thinking' },
      { id: 'xhigh', label: 'Max', description: 'Largest thinking budget' },
    ]);
  }

  return [];
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
    reasoningEffort: input.reasoningEffort,
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
