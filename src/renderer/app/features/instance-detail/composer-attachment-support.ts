import { providerAcceptsAttachments } from '../../../../shared/provider-attachment-support';
import { TOOLTIP_COPY } from '../../shared/tooltip/tooltip-copy';
import type { InstanceRuntimeSummary, ModelRuntimeTarget } from '../../../../shared/types/local-model-runtime.types';

interface ComposerAttachmentContext {
  attachmentProviderOverride(): string | null;
  isDraftComposer(): boolean;
  selectedProvider(): string;
  runtimeSummary(): InstanceRuntimeSummary | undefined;
  provider(): string;
}

/** Keep provider reads lazy: an archive override wins over draft and live runtimes. */
export function composerAttachmentProvider(
  context: ComposerAttachmentContext,
  draftRuntimeTarget: () => ModelRuntimeTarget | null,
): string {
  return context.attachmentProviderOverride() ?? (context.isDraftComposer()
    ? draftRuntimeTarget()?.kind === 'local-model'
      ? 'local-model' : context.selectedProvider()
    : context.runtimeSummary()?.kind === 'local-model' ? 'local-model' : context.provider());
}

export function composerAttachmentDisabledReason(
  context: ComposerAttachmentContext,
  draftRuntimeTarget: () => ModelRuntimeTarget | null,
): string | null {
  return attachmentDisabledReason(composerAttachmentProvider(context, draftRuntimeTarget));
}

export function attachmentDisabledReason(provider: string): string | null {
  if (providerAcceptsAttachments(provider)) return null;
  if (provider === 'gemini') return TOOLTIP_COPY['composer.attachGemini'].meaning;
  if (provider === 'antigravity') return TOOLTIP_COPY['composer.attachAntigravity'].meaning;
  return TOOLTIP_COPY['composer.attachLocalModel'].meaning;
}
