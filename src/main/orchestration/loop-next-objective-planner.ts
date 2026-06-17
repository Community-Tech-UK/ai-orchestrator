import type { AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';
import type { NextObjectivePlanner } from '../../shared/types/loop.types';
import { getAuxiliaryLlmService } from '../rlm/auxiliary-llm-service';

interface AuxiliaryGenerateResult {
  text: string;
}

type AuxiliaryGenerate = (
  slot: AuxiliaryLlmSlot,
  systemPrompt: string,
  userPrompt: string,
) => Promise<AuxiliaryGenerateResult>;

export function parseNextObjectivePlannerOutput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as {
        objective?: unknown;
        nextObjective?: unknown;
      };
      const objective = typeof parsed.objective === 'string'
        ? parsed.objective
        : typeof parsed.nextObjective === 'string'
          ? parsed.nextObjective
          : '';
      const normalized = objective.trim();
      return normalized ? normalized.slice(0, 2000) : null;
    }
  } catch {
    // Fall through to plain text handling.
  }

  return trimmed.slice(0, 2000);
}

export function createAuxiliaryNextObjectivePlanner(
  deps: { generate?: AuxiliaryGenerate } = {},
): NextObjectivePlanner {
  const generate: AuxiliaryGenerate = deps.generate ?? ((slot, systemPrompt, userPrompt) =>
    getAuxiliaryLlmService().generate(slot, systemPrompt, userPrompt));

  return async ({ lastOutput, originalGoal, seq }) => {
    const systemPrompt =
      'You choose the next concrete objective for an autonomous coding loop. ' +
      'The loop stop decision is handled elsewhere by evidence checks. ' +
      'Return ONLY JSON like {"objective":"one concrete next step"}; do not say the work is done.';
    const userPrompt = [
      `Original goal:\n${originalGoal}`,
      `Completed iteration sequence: ${seq}`,
      `Latest iteration output:\n${lastOutput.slice(0, 8000)}`,
      'Pick the next concrete objective that moves toward the original goal. ' +
        'If there is no useful next focus, return {"objective":""}.',
    ].join('\n\n');

    const result = await generate('loopScoring', systemPrompt, userPrompt);
    return parseNextObjectivePlannerOutput(result.text);
  };
}
