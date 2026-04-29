import type {
  DisagreementPoint,
  RiskArea,
  RiskAreaCategory,
  RiskAreaSeverity,
  UniqueInsight,
  VerdictDerivationDiagnostic,
  VerdictEvidence,
  VerdictStatus,
  VerificationAnalysis,
  VerificationResult,
  VerificationVerdict,
} from '../../shared/types/verification.types';
import { VERIFICATION_VERDICT_SCHEMA_VERSION } from '../../shared/types/verification.types';

export interface DeriveVerdictOptions {
  inconclusiveBelow?: number;
  blockedBelow?: number;
  passAtOrAbove?: number;
  now?: number;
}

export interface DeriveVerdictResult {
  verdict: VerificationVerdict;
  diagnostic: VerdictDerivationDiagnostic;
}

const DEFAULT_INCONCLUSIVE_BELOW = 0.4;
const DEFAULT_BLOCKED_BELOW = 0.5;
const DEFAULT_PASS_AT_OR_ABOVE = 0.85;
const MAX_ACTIONS = 10;
const MAX_SNIPPET_LENGTH = 280;

export function deriveVerdict(
  result: VerificationResult,
  options: DeriveVerdictOptions = {},
): DeriveVerdictResult {
  const now = options.now ?? Date.now();
  const confidence = clampConfidence(result.synthesisConfidence);
  const analysis = getValidAnalysis(result.analysis);
  let diagnostic: VerdictDerivationDiagnostic = { reason: 'normal' };

  if (!analysis) {
    diagnostic = {
      reason: 'missing-analysis',
      note: 'Verification result did not include a usable analysis object.',
    };
    return buildResult(result, {
      status: 'inconclusive',
      confidence,
      requiredActions: [],
      riskAreas: [],
      evidence: buildResponseEvidence(result),
      diagnostic,
      now,
    });
  }

  if (confidence < (options.inconclusiveBelow ?? DEFAULT_INCONCLUSIVE_BELOW)) {
    diagnostic = {
      reason: 'low-confidence',
      note: `Synthesis confidence ${confidence.toFixed(2)} is below the inconclusive threshold.`,
    };
  }

  const disagreementActions = extractRequiredActions(analysis.disagreements);
  const outlierActions = analysis.outlierAgents.map((agentId) =>
    `Review outlier response from ${agentId}.`
  );
  const requiredActions = [...disagreementActions, ...outlierActions].slice(0, MAX_ACTIONS);
  const riskAreas = [
    ...analysis.disagreements.map(riskFromDisagreement),
    ...analysis.outlierAgents.map((agentId): RiskArea => ({
      category: 'correctness',
      description: `Outlier response from ${agentId} differs materially from the group.`,
      severity: confidence < (options.blockedBelow ?? DEFAULT_BLOCKED_BELOW) ? 'high' : 'medium',
      agentIds: [agentId],
    })),
    ...analysis.uniqueInsights
      .filter((insight) => insight.category === 'warning' || insight.value === 'high')
      .map(riskFromUniqueInsight),
  ].slice(0, MAX_ACTIONS);
  const evidence = [
    ...buildAgreementEvidence(analysis),
    ...buildDisagreementEvidence(analysis),
    ...buildOutlierEvidence(analysis),
    ...buildUniqueInsightEvidence(analysis),
  ];
  const status = chooseStatus({
    analysis,
    confidence,
    requiredActions,
    riskAreas,
    inconclusiveBelow: options.inconclusiveBelow ?? DEFAULT_INCONCLUSIVE_BELOW,
    blockedBelow: options.blockedBelow ?? DEFAULT_BLOCKED_BELOW,
    passAtOrAbove: options.passAtOrAbove ?? DEFAULT_PASS_AT_OR_ABOVE,
  });

  if (
    diagnostic.reason === 'normal'
    && status === 'pass-with-notes'
    && analysis.disagreements.length === 0
    && analysis.outlierAgents.length === 0
  ) {
    diagnostic = {
      reason: 'no-disagreements',
      note: 'No disagreements or outliers were present; verdict reflects confidence level.',
    };
  }

  return buildResult(result, {
    status,
    confidence,
    requiredActions,
    riskAreas,
    evidence,
    diagnostic,
    now,
  });
}

export function headlineForStatus(status: VerdictStatus): string {
  switch (status) {
    case 'pass':
      return 'Verification passed';
    case 'pass-with-notes':
      return 'Verification passed with notes';
    case 'needs-changes':
      return 'Changes are recommended';
    case 'blocked':
      return 'Human review is required';
    case 'inconclusive':
      return 'Verification was inconclusive';
  }
}

function buildResult(
  result: VerificationResult,
  details: {
    status: VerdictStatus;
    confidence: number;
    requiredActions: string[];
    riskAreas: RiskArea[];
    evidence: VerdictEvidence[];
    diagnostic: VerdictDerivationDiagnostic;
    now: number;
  },
): DeriveVerdictResult {
  return {
    verdict: {
      status: details.status,
      confidence: details.confidence,
      headline: headlineForStatus(details.status),
      requiredActions: details.requiredActions,
      riskAreas: details.riskAreas,
      evidence: details.evidence,
      rawResponses: result.responses,
      sourceResultId: result.id,
      derivedAt: details.now,
      schemaVersion: VERIFICATION_VERDICT_SCHEMA_VERSION,
    },
    diagnostic: details.diagnostic,
  };
}

function chooseStatus(input: {
  analysis: VerificationAnalysis;
  confidence: number;
  requiredActions: string[];
  riskAreas: RiskArea[];
  inconclusiveBelow: number;
  blockedBelow: number;
  passAtOrAbove: number;
}): VerdictStatus {
  if (input.confidence < input.inconclusiveBelow) {
    return 'inconclusive';
  }
  if (
    input.analysis.disagreements.some((disagreement) => disagreement.requiresHumanReview)
    || (input.analysis.outlierAgents.length > 0 && input.confidence < input.blockedBelow)
  ) {
    return 'blocked';
  }
  if (input.requiredActions.length > 0) {
    return 'needs-changes';
  }
  if (input.riskAreas.length > 0) {
    return input.confidence >= 0.7 ? 'pass-with-notes' : 'needs-changes';
  }
  return input.confidence >= input.passAtOrAbove ? 'pass' : 'pass-with-notes';
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function getValidAnalysis(value: unknown): VerificationAnalysis | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const analysis = value as VerificationAnalysis;
  if (
    !Array.isArray(analysis.agreements)
    || !Array.isArray(analysis.disagreements)
    || !Array.isArray(analysis.uniqueInsights)
    || !Array.isArray(analysis.outlierAgents)
  ) {
    return null;
  }
  return analysis;
}

function extractRequiredActions(disagreements: DisagreementPoint[]): string[] {
  return disagreements
    .filter((disagreement) => disagreement.requiresHumanReview || disagreement.positions.length > 1)
    .map((disagreement) => `Resolve disagreement: ${disagreement.topic}.`);
}

function riskFromDisagreement(disagreement: DisagreementPoint): RiskArea {
  return {
    category: classifyRiskCategory(disagreement.topic),
    description: disagreement.topic,
    severity: disagreement.requiresHumanReview ? 'high' : severityFromPositions(disagreement.positions.length),
    agentIds: disagreement.positions.map((position) => position.agentId),
  };
}

function riskFromUniqueInsight(insight: UniqueInsight): RiskArea {
  return {
    category: classifyRiskCategory(insight.point),
    description: insight.point,
    severity: insight.value === 'high' ? 'medium' : 'low',
    agentIds: [insight.agentId],
  };
}

function severityFromPositions(positionCount: number): RiskAreaSeverity {
  if (positionCount >= 3) {
    return 'high';
  }
  if (positionCount === 2) {
    return 'medium';
  }
  return 'low';
}

function classifyRiskCategory(value: string): RiskAreaCategory {
  const normalized = value.toLowerCase();
  if (/\b(auth|token|secret|injection|permission|security)\b/.test(normalized)) {
    return 'security';
  }
  if (/\b(speed|slow|latency|performance|memory|cpu)\b/.test(normalized)) {
    return 'performance';
  }
  if (/\b(compat|version|platform|browser|electron|os)\b/.test(normalized)) {
    return 'compatibility';
  }
  if (/\b(delete|loss|corrupt|destructive|overwrite)\b/.test(normalized)) {
    return 'data-loss';
  }
  if (/\b(ui|ux|user|screen|accessib|layout)\b/.test(normalized)) {
    return 'ux';
  }
  if (/\b(refactor|maintain|complex|duplicate)\b/.test(normalized)) {
    return 'maintainability';
  }
  if (/\b(correct|correctness|bug|fail|logic|regress)\b/.test(normalized)) {
    return 'correctness';
  }
  return 'unknown';
}

function buildResponseEvidence(result: VerificationResult): VerdictEvidence[] {
  return result.responses.map((response) => ({
    kind: 'agent-response',
    agentId: response.agentId,
    snippet: truncate(response.response),
  }));
}

function buildAgreementEvidence(analysis: VerificationAnalysis): VerdictEvidence[] {
  return analysis.agreements.slice(0, 5).map((agreement) => ({
    kind: 'agreement',
    snippet: truncate(agreement.point),
  }));
}

function buildDisagreementEvidence(analysis: VerificationAnalysis): VerdictEvidence[] {
  return analysis.disagreements.map((disagreement) => ({
    kind: 'disagreement',
    snippet: truncate(disagreement.topic),
  }));
}

function buildOutlierEvidence(analysis: VerificationAnalysis): VerdictEvidence[] {
  return analysis.outlierAgents.map((agentId) => ({
    kind: 'outlier',
    agentId,
    snippet: `Outlier: ${agentId}`,
  }));
}

function buildUniqueInsightEvidence(analysis: VerificationAnalysis): VerdictEvidence[] {
  return analysis.uniqueInsights.slice(0, 5).map((insight) => ({
    kind: 'unique-insight',
    agentId: insight.agentId,
    snippet: truncate(insight.point),
  }));
}

function truncate(value: string): string {
  return value.length > MAX_SNIPPET_LENGTH
    ? `${value.slice(0, MAX_SNIPPET_LENGTH - 3)}...`
    : value;
}
