/**
 * Judge - LLM-based evaluation of benchmark outputs
 *
 * Uses Claude and Codex as dual judges to evaluate real-codebase task outputs.
 * Outputs are presented blind (randomized order) to avoid bias.
 */

import { spawn } from 'child_process';
import type { BenchmarkTask, JudgeScore, JudgeScores } from './types.js';

/**
 * Configuration for judge API calls
 */
export interface JudgeConfig {
  claudeApiKey?: string;
  codexApiKey?: string;
  claudeModel?: string;
  codexModel?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

const DEFAULT_CONFIG: Required<JudgeConfig> = {
  claudeApiKey: process.env['ANTHROPIC_API_KEY'] || '',
  codexApiKey: process.env['OPENAI_API_KEY'] || '',
  claudeModel: 'claude-sonnet-4-20250514',
  codexModel: 'gpt-5.5',
  maxRetries: 3,
  timeoutMs: 300000,
};

/**
 * Result of a blind evaluation
 */
export interface BlindEvaluation {
  responseA: JudgeScore;
  responseB: JudgeScore;
  /** Which response was actually vanilla (for de-randomization) */
  vanillaWas: 'A' | 'B';
}

/**
 * Generate the evaluation prompt for judges
 */
function buildEvaluationPrompt(
  task: BenchmarkTask,
  responseA: string,
  responseB: string
): string {
  return `You are evaluating two AI responses to a software engineering task.
You do not know which response comes from which system - evaluate them purely on merit.

## Task
${task.prompt}

## Response A
${responseA}

## Response B
${responseB}

## Evaluation Criteria

Score each response on three dimensions (0-10 scale):

1. **Completeness** (0-10): Did it cover all relevant files, components, and aspects of the question?
   - 0-3: Missing major components
   - 4-6: Covers main points but missing some details
   - 7-9: Comprehensive coverage
   - 10: Exhaustive and thorough

2. **Accuracy** (0-10): Are the statements factually correct about the code?
   - 0-3: Contains significant errors
   - 4-6: Mostly correct with some inaccuracies
   - 7-9: Accurate with minor issues
   - 10: Completely accurate

3. **Actionability** (0-10): Could someone act on this answer to solve the problem?
   - 0-3: Vague or unhelpful
   - 4-6: Provides some guidance
   - 7-9: Clear, actionable guidance
   - 10: Immediately actionable with specific steps

## Response Format

Return ONLY valid JSON in this exact format:
{
  "response_a": {
    "completeness": <number 0-10>,
    "accuracy": <number 0-10>,
    "actionability": <number 0-10>,
    "notes": "<brief explanation>"
  },
  "response_b": {
    "completeness": <number 0-10>,
    "accuracy": <number 0-10>,
    "actionability": <number 0-10>,
    "notes": "<brief explanation>"
  }
}`;
}

/**
 * Parse judge response into scores
 */
function parseJudgeResponse(response: string): { response_a: JudgeScore; response_b: JudgeScore } | null {
  try {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    // Try to find JSON object in the response
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      jsonStr = objectMatch[0];
    }

    const parsed = JSON.parse(jsonStr);

    // Validate structure
    if (!parsed.response_a || !parsed.response_b) {
      console.error('Judge response missing response_a or response_b');
      return null;
    }

    const validateScore = (obj: unknown): JudgeScore | null => {
      if (typeof obj !== 'object' || obj === null) return null;
      const o = obj as Record<string, unknown>;

      const completeness = Number(o['completeness']);
      const accuracy = Number(o['accuracy']);
      const actionability = Number(o['actionability']);

      if (isNaN(completeness) || isNaN(accuracy) || isNaN(actionability)) {
        return null;
      }

      return {
        completeness: Math.max(0, Math.min(10, completeness)),
        accuracy: Math.max(0, Math.min(10, accuracy)),
        actionability: Math.max(0, Math.min(10, actionability)),
        notes: typeof o['notes'] === 'string' ? o['notes'] : undefined,
      };
    };

    const a = validateScore(parsed.response_a);
    const b = validateScore(parsed.response_b);

    if (!a || !b) {
      console.error('Judge response has invalid score structure');
      return null;
    }

    return { response_a: a, response_b: b };
  } catch (e) {
    console.error('Failed to parse judge response:', e);
    return null;
  }
}

/**
 * Call Claude CLI as a judge fallback (no API key needed)
 */
async function callCliJudge(
  prompt: string,
  timeoutMs: number
): Promise<JudgeScore[] | null> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['--print', '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.stdin?.write(prompt);
    proc.stdin?.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      console.error('CLI judge timed out');
      resolve(null);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);

      // Extract text from JSON output (same as vanilla-executor pattern)
      let output = '';
      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text') output += block.text + '\n';
            }
          }
          if (parsed.type === 'result' && parsed.result && typeof parsed.result === 'string') {
            output += parsed.result + '\n';
          }
        } catch {
          output += line + '\n';
        }
      }

      const content = output.trim() || stdout.trim();
      if (!content || code !== 0) {
        console.error(`CLI judge failed (exit ${code}): ${stderr.slice(0, 200)}`);
        resolve(null);
        return;
      }

      const scores = parseJudgeResponse(content);
      if (!scores) { resolve(null); return; }
      resolve([scores.response_a, scores.response_b]);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      console.error('CLI judge process error:', err.message);
      resolve(null);
    });
  });
}

/**
 * Call Claude API for evaluation
 */
async function callClaudeJudge(
  prompt: string,
  config: Required<JudgeConfig>
): Promise<JudgeScore[] | null> {
  if (!config.claudeApiKey) {
    console.log('Claude API key not configured, falling back to CLI judge');
    return callCliJudge(prompt, config.timeoutMs);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.claudeModel,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Claude API error: ${response.status} - ${errorText}`);
      return null;
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;

    if (!content) {
      console.error('Claude response missing content');
      return null;
    }

    const parsed = parseJudgeResponse(content);
    if (!parsed) return null;

    return [parsed.response_a, parsed.response_b];
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof Error && e.name === 'AbortError') {
      console.error('Claude API call timed out');
    } else {
      console.error('Claude API call failed:', e);
    }
    return null;
  }
}

/**
 * Call OpenAI/Codex API for evaluation
 */
async function callCodexJudge(
  prompt: string,
  config: Required<JudgeConfig>
): Promise<JudgeScore[] | null> {
  if (!config.codexApiKey) {
    console.log('Codex/OpenAI API key not configured, falling back to CLI judge');
    return callCliJudge(prompt, config.timeoutMs);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.codexApiKey}`,
      },
      body: JSON.stringify({
        model: config.codexModel,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Codex API error: ${response.status} - ${errorText}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error('Codex response missing content');
      return null;
    }

    const parsed = parseJudgeResponse(content);
    if (!parsed) return null;

    return [parsed.response_a, parsed.response_b];
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof Error && e.name === 'AbortError') {
      console.error('Codex API call timed out');
    } else {
      console.error('Codex API call failed:', e);
    }
    return null;
  }
}

/**
 * Randomize the order of responses for blind evaluation
 */
function randomizeResponses(
  vanillaOutput: string,
  orchestratorOutput: string
): { responseA: string; responseB: string; vanillaWas: 'A' | 'B' } {
  if (Math.random() < 0.5) {
    return {
      responseA: vanillaOutput,
      responseB: orchestratorOutput,
      vanillaWas: 'A',
    };
  } else {
    return {
      responseA: orchestratorOutput,
      responseB: vanillaOutput,
      vanillaWas: 'B',
    };
  }
}

/**
 * De-randomize scores back to vanilla/orchestrator
 */
function derandomizeScores(
  scores: JudgeScore[],
  vanillaWas: 'A' | 'B'
): { vanilla: JudgeScore; orchestrator: JudgeScore } {
  if (vanillaWas === 'A') {
    return { vanilla: scores[0], orchestrator: scores[1] };
  } else {
    return { vanilla: scores[1], orchestrator: scores[0] };
  }
}

/**
 * Check if judges disagree significantly
 */
function checkDisagreement(claude: JudgeScore, codex: JudgeScore): boolean {
  const threshold = 2;
  return (
    Math.abs(claude.completeness - codex.completeness) > threshold ||
    Math.abs(claude.accuracy - codex.accuracy) > threshold ||
    Math.abs(claude.actionability - codex.actionability) > threshold
  );
}

/**
 * Evaluate two outputs using dual judges
 */
export async function evaluateWithJudges(
  task: BenchmarkTask,
  vanillaOutput: string,
  orchestratorOutput: string,
  config: Partial<JudgeConfig> = {}
): Promise<JudgeScores | null> {
  const fullConfig: Required<JudgeConfig> = { ...DEFAULT_CONFIG, ...config };

  // Randomize order for blind evaluation
  const { responseA, responseB, vanillaWas } = randomizeResponses(
    vanillaOutput,
    orchestratorOutput
  );

  // Build prompt
  const prompt = buildEvaluationPrompt(task, responseA, responseB);

  // Call both judges in parallel
  const [claudeScores, codexScores] = await Promise.all([
    callClaudeJudge(prompt, fullConfig),
    callCodexJudge(prompt, fullConfig),
  ]);

  // Handle partial results
  if (!claudeScores && !codexScores) {
    console.error('Both judges failed to respond');
    return null;
  }

  // If one judge failed, use the other for both (with a warning)
  let finalClaudeScores = claudeScores;
  let finalCodexScores = codexScores;

  if (!claudeScores && codexScores) {
    console.warn('Claude judge failed, using Codex scores for both');
    finalClaudeScores = codexScores;
  }
  if (!codexScores && claudeScores) {
    console.warn('Codex judge failed, using Claude scores for both');
    finalCodexScores = claudeScores;
  }

  // De-randomize scores
  const claude = derandomizeScores(finalClaudeScores!, vanillaWas);
  const codex = derandomizeScores(finalCodexScores!, vanillaWas);

  // Check for significant disagreement
  const vanillaDisagree = checkDisagreement(claude.vanilla, codex.vanilla);
  const orchestratorDisagree = checkDisagreement(claude.orchestrator, codex.orchestrator);
  const needsHumanReview = vanillaDisagree || orchestratorDisagree;

  if (needsHumanReview) {
    console.warn(`Task ${task.id}: Judges disagree significantly, flagged for human review`);
  }

  return {
    claude: claude.orchestrator, // Return orchestrator scores (primary interest)
    codex: codex.orchestrator,
    needsHumanReview,
  };
}

/**
 * Evaluate a single response (for known-answer tasks that need qualitative backup)
 */
export async function evaluateSingleResponse(
  task: BenchmarkTask,
  output: string,
  config: Partial<JudgeConfig> = {}
): Promise<JudgeScore | null> {
  const fullConfig: Required<JudgeConfig> = { ...DEFAULT_CONFIG, ...config };

  const prompt = `You are evaluating an AI response to a software engineering task.

## Task
${task.prompt}

## Response
${output}

## Evaluation Criteria

Score the response on three dimensions (0-10 scale):

1. **Completeness** (0-10): Did it cover all relevant files, components, and aspects?
2. **Accuracy** (0-10): Are the statements factually correct about the code?
3. **Actionability** (0-10): Could someone act on this answer?

Return ONLY valid JSON:
{
  "completeness": <number 0-10>,
  "accuracy": <number 0-10>,
  "actionability": <number 0-10>,
  "notes": "<brief explanation>"
}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fullConfig.timeoutMs);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': fullConfig.claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: fullConfig.claudeModel,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;
    if (!content) return null;

    // Parse single score
    let jsonStr = content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);
    return {
      completeness: Math.max(0, Math.min(10, Number(parsed.completeness) || 0)),
      accuracy: Math.max(0, Math.min(10, Number(parsed.accuracy) || 0)),
      actionability: Math.max(0, Math.min(10, Number(parsed.actionability) || 0)),
      notes: parsed.notes,
    };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * Get agreement statistics from a set of judge scores
 */
export function calculateAgreementStats(
  judgeResults: Array<{ claude: JudgeScore; codex: JudgeScore }>
): {
  agreementRate: number;
  avgDifferenceCompleteness: number;
  avgDifferenceAccuracy: number;
  avgDifferenceActionability: number;
} {
  if (judgeResults.length === 0) {
    return {
      agreementRate: 0,
      avgDifferenceCompleteness: 0,
      avgDifferenceAccuracy: 0,
      avgDifferenceActionability: 0,
    };
  }

  let agreements = 0;
  let totalDiffC = 0;
  let totalDiffA = 0;
  let totalDiffAc = 0;

  for (const result of judgeResults) {
    const diffC = Math.abs(result.claude.completeness - result.codex.completeness);
    const diffA = Math.abs(result.claude.accuracy - result.codex.accuracy);
    const diffAc = Math.abs(result.claude.actionability - result.codex.actionability);

    totalDiffC += diffC;
    totalDiffA += diffA;
    totalDiffAc += diffAc;

    // Agreement = all dimensions within 2 points
    if (diffC <= 2 && diffA <= 2 && diffAc <= 2) {
      agreements++;
    }
  }

  const n = judgeResults.length;
  return {
    agreementRate: agreements / n,
    avgDifferenceCompleteness: totalDiffC / n,
    avgDifferenceAccuracy: totalDiffA / n,
    avgDifferenceActionability: totalDiffAc / n,
  };
}
