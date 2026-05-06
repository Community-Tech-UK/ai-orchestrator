import { resolveCliType } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import type { CliType as SettingsCliType } from '../../shared/types/settings.types';

export interface ReviewExecutionHost {
  getWorkingDirectory(instanceId: string): string | undefined;
  getTaskDescription(instanceId: string): string | undefined;
  dispatchReviewerPrompt(provider: string, prompt: string, cwd: string, signal: AbortSignal): Promise<string>;
}

export interface HeadlessReviewRequest {
  target: string;
  cwd: string;
  content: string;
  taskDescription: string;
  reviewers?: string[];
  primaryProvider?: string;
  reviewDepth?: 'structured' | 'tiered';
  timeoutSeconds?: number;
}

function isCliAdapterLike(adapter: unknown): adapter is { sendMessage: (m: CliMessage) => Promise<CliResponse> } {
  return typeof (adapter as Record<string, unknown>)?.['sendMessage'] === 'function';
}

function isTerminableAdapter(adapter: unknown): adapter is { terminate: (graceful?: boolean) => Promise<void> } {
  return typeof (adapter as Record<string, unknown>)?.['terminate'] === 'function';
}

export class ProviderReviewExecutionHost implements ReviewExecutionHost {
  getWorkingDirectory(): string | undefined {
    return undefined;
  }

  getTaskDescription(): string | undefined {
    return undefined;
  }

  async dispatchReviewerPrompt(
    provider: string,
    prompt: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) {
      throw new Error('Review cancelled');
    }

    const resolvedCli = await resolveCliType(provider as SettingsCliType);
    const adapter = getProviderRuntimeService().createAdapter({
      cliType: resolvedCli,
      options: {
        workingDirectory: cwd,
        yoloMode: false,
      },
    });

    try {
      if (!isCliAdapterLike(adapter)) {
        throw new Error(`CLI adapter "${provider}" does not support sendMessage`);
      }
      if (signal.aborted) {
        throw new Error('Review cancelled');
      }
      const response = await adapter.sendMessage({ role: 'user', content: prompt });
      return response.content;
    } finally {
      if (isTerminableAdapter(adapter)) {
        await adapter.terminate(false);
      }
    }
  }
}
