import type {
  EvidenceCaptureCompleteness,
  WorkingSetAllocation,
} from '@contracts/types/context-evidence';
import { ContextTokenEstimator } from './context-token-estimator';

const UNKNOWN_WINDOW_ALLOCATION = {
  instructionsTokens: 1_024,
  recentDialogueTokens: 1_024,
  evidenceCardTokens: 1_024,
  exactExcerptTokens: 1_024,
  reasoningAndAnswerTokens: 2_048,
  emergencyReserveTokens: 1_024,
} as const;

export interface WorkingSetCandidate {
  id: string;
  content: string;
  createdAt: number;
  captureCompleteness: EvidenceCaptureCompleteness;
  disclosure?: string;
  explicitUserReference?: boolean;
  hasUnresolvedContradiction?: boolean;
  failedVerification?: boolean;
  activeTaskEntityMatches?: number;
  priorCitationUse?: boolean;
  exactExcerptStillNeeded?: boolean;
  relevanceScore?: number;
}

export interface WorkingSetPlanInput {
  capacityTokens?: number;
  largerModelCapacityTokens?: number;
  requiredInstructions: string[];
  latestUserIntent: string;
  recentDialogue: WorkingSetCandidate[];
  activeTaskState: string[];
  evidenceCards: WorkingSetCandidate[];
  exactExcerpts: WorkingSetCandidate[];
}

export interface WorkingSetSelection {
  recentDialogue: WorkingSetCandidate[];
  evidenceCards: WorkingSetCandidate[];
  exactExcerpts: WorkingSetCandidate[];
}

export interface WorkingSetPlan {
  status: 'ready' | 'degraded' | 'paused';
  allocation: WorkingSetAllocation;
  requiredControl: string[];
  requiredControlTokens: number;
  controlPlaneOverageTokens: number;
  selected: WorkingSetSelection;
  usedTokens: {
    recentDialogue: number;
    evidenceCards: number;
    exactExcerpts: number;
  };
  unusedOptionalTokens: number;
  reasoningAndEmergencyAvailableTokens: number;
  renderAccounting: WorkingSetRenderAccounting;
  disclosures: string[];
}

export interface WorkingSetRenderAccounting {
  totalTokens: number;
  structuralOverheadTokens: number;
  estimateKind: WorkingSetAllocation['estimateKind'];
  sectionTokens: {
    requiredControl: number;
    recentDialogue: number;
    evidenceCards: number;
    exactExcerpts: number;
  };
}

interface SelectedCandidates {
  items: WorkingSetCandidate[];
  tokens: number;
}

export class WorkingSetPlanner {
  constructor(private readonly estimator = new ContextTokenEstimator()) {}

  plan(input: WorkingSetPlanInput): WorkingSetPlan {
    const requiredControl = [
      ...input.requiredInstructions,
      ...(input.latestUserIntent ? [input.latestUserIntent] : []),
    ];
    const requiredControlTokens = this.countAll(requiredControl);
    const disclosures: string[] = [];
    const capacityTokens = selectCapacity(input, requiredControlTokens, disclosures);
    const base = capacityTokens === undefined
      ? this.unknownWindowAllocation()
      : this.knownWindowAllocation(capacityTokens);
    const targetControlTokens = base.instructionsTokens;
    const maximumOrdinaryTokens = base.normalWorkingSetTokens;
    const controlPlaneOverageTokens = Math.max(0, requiredControlTokens - targetControlTokens);

    if (capacityTokens === undefined) {
      disclosures.push('Provider context capacity is unknown; absolute token budgets are in effect.');
    }

    if (requiredControlTokens > maximumOrdinaryTokens) {
      disclosures.push('Required control-plane content exceeds the safe ordinary working-set budget; the request is paused without truncation.');
      return {
        status: 'paused',
        allocation: base,
        requiredControl,
        requiredControlTokens,
        controlPlaneOverageTokens,
        selected: { recentDialogue: [], evidenceCards: [], exactExcerpts: [] },
        usedTokens: { recentDialogue: 0, evidenceCards: 0, exactExcerpts: 0 },
        unusedOptionalTokens:
          base.recentDialogueTokens + base.evidenceCardTokens + base.exactExcerptTokens,
        reasoningAndEmergencyAvailableTokens:
          base.reasoningAndAnswerTokens
          + base.emergencyReserveTokens
          + base.recentDialogueTokens
          + base.evidenceCardTokens
          + base.exactExcerptTokens,
        renderAccounting: emptyRenderAccounting(base.estimateKind),
        disclosures,
      };
    }

    const allocation = this.rebalanceForControlOverage(base, requiredControlTokens);
    let status: WorkingSetPlan['status'] = 'ready';
    if (
      capacityTokens !== undefined
      && requiredControlTokens > Math.floor(capacityTokens * 0.3)
    ) {
      status = 'degraded';
      disclosures.push('Required control-plane content exceeds 30% of the provider window.');
    }

    const activeTaskCandidates = input.activeTaskState.map((content, index) => ({
      id: `active-task-${index.toString().padStart(4, '0')}`,
      content,
      createdAt: Number.MAX_SAFE_INTEGER - index,
      captureCompleteness: 'complete' as const,
      activeTaskEntityMatches: 10,
    }));
    const recentDialogue = this.select(
      [...activeTaskCandidates, ...input.recentDialogue],
      allocation.recentDialogueTokens,
      'dialogue',
    );
    const evidenceCards = this.select(
      input.evidenceCards,
      allocation.evidenceCardTokens,
      'card',
    );
    const exactExcerpts = this.select(
      input.exactExcerpts,
      allocation.exactExcerptTokens,
      'excerpt',
    );
    this.trimToRenderedBudget(
      requiredControl,
      { recentDialogue, evidenceCards, exactExcerpts },
      allocation.normalWorkingSetTokens,
    );
    const renderAccounting = this.measureRendered(requiredControl, {
      recentDialogue: recentDialogue.items,
      evidenceCards: evidenceCards.items,
      exactExcerpts: exactExcerpts.items,
    });
    if (renderAccounting.totalTokens > allocation.normalWorkingSetTokens) {
      disclosures.push('Required control-plane rendering overhead exceeds the safe ordinary working-set budget; the request is paused without truncation.');
      return {
        status: 'paused',
        allocation,
        requiredControl,
        requiredControlTokens,
        controlPlaneOverageTokens,
        selected: { recentDialogue: [], evidenceCards: [], exactExcerpts: [] },
        usedTokens: { recentDialogue: 0, evidenceCards: 0, exactExcerpts: 0 },
        unusedOptionalTokens:
          allocation.recentDialogueTokens
          + allocation.evidenceCardTokens
          + allocation.exactExcerptTokens,
        reasoningAndEmergencyAvailableTokens:
          allocation.reasoningAndAnswerTokens
          + allocation.emergencyReserveTokens
          + allocation.recentDialogueTokens
          + allocation.evidenceCardTokens
          + allocation.exactExcerptTokens,
        renderAccounting: emptyRenderAccounting(allocation.estimateKind),
        disclosures,
      };
    }
    const unusedOptionalTokens =
      allocation.recentDialogueTokens - recentDialogue.tokens
      + allocation.evidenceCardTokens - evidenceCards.tokens
      + allocation.exactExcerptTokens - exactExcerpts.tokens;

    return {
      status,
      allocation,
      requiredControl,
      requiredControlTokens,
      controlPlaneOverageTokens,
      selected: {
        recentDialogue: recentDialogue.items,
        evidenceCards: evidenceCards.items,
        exactExcerpts: exactExcerpts.items,
      },
      usedTokens: {
        recentDialogue: recentDialogue.tokens,
        evidenceCards: evidenceCards.tokens,
        exactExcerpts: exactExcerpts.tokens,
      },
      unusedOptionalTokens,
      reasoningAndEmergencyAvailableTokens:
        allocation.reasoningAndAnswerTokens
        + allocation.emergencyReserveTokens
        + unusedOptionalTokens,
      renderAccounting,
      disclosures,
    };
  }

  private trimToRenderedBudget(
    requiredControl: string[],
    selected: {
      recentDialogue: SelectedCandidates;
      evidenceCards: SelectedCandidates;
      exactExcerpts: SelectedCandidates;
    },
    maximumTokens: number,
  ): void {
    while (this.measureRendered(requiredControl, {
      recentDialogue: selected.recentDialogue.items,
      evidenceCards: selected.evidenceCards.items,
      exactExcerpts: selected.exactExcerpts.items,
    }).totalTokens > maximumTokens) {
      const collection = selected.exactExcerpts.items.length > 0
        ? selected.exactExcerpts
        : selected.evidenceCards.items.length > 0
          ? selected.evidenceCards
          : selected.recentDialogue.items.length > 0
            ? selected.recentDialogue
            : null;
      if (!collection) return;
      collection.items.pop();
      collection.tokens = this.measureSelection(collection.items, collection === selected.recentDialogue
        ? 'dialogue'
        : collection === selected.evidenceCards ? 'card' : 'excerpt');
    }
  }

  private measureSelection(
    items: WorkingSetCandidate[],
    kind: 'dialogue' | 'card' | 'excerpt',
  ): number {
    return this.estimator.estimate(items.map((candidate) => kind === 'dialogue'
      ? candidate.content
      : formatUntrustedEvidence(candidate, kind)).join('\n')).tokens;
  }

  private measureRendered(
    requiredControl: string[],
    selected: WorkingSetSelection,
  ): WorkingSetRenderAccounting {
    const representation = buildWorkingSetRepresentation(requiredControl, selected);
    const sectionTokens = {
      requiredControl: this.estimator.estimate(representation.requiredControl).tokens,
      recentDialogue: this.estimator.estimate(representation.recentDialogue).tokens,
      evidenceCards: this.estimator.estimate(representation.evidenceCards).tokens,
      exactExcerpts: this.estimator.estimate(representation.exactExcerpts).tokens,
    };
    const totalTokens = this.estimator.estimate(representation.content).tokens;
    return {
      totalTokens,
      structuralOverheadTokens: Math.max(
        0,
        totalTokens - Object.values(sectionTokens).reduce((sum, tokens) => sum + tokens, 0),
      ),
      estimateKind: this.estimator.estimate(representation.content).estimateKind,
      sectionTokens,
    };
  }

  private knownWindowAllocation(capacityTokens: number): WorkingSetAllocation {
    const safeCapacity = Math.max(1, Math.floor(capacityTokens));
    const fifteenPercent = Math.floor(safeCapacity * 0.15);
    const reasoningAndAnswerTokens = Math.floor(safeCapacity * 0.25);
    const allocatedBeforeEmergency = fifteenPercent * 4 + reasoningAndAnswerTokens;
    const emergencyReserveTokens = safeCapacity - allocatedBeforeEmergency;
    return {
      capacityTokens: safeCapacity,
      instructionsTokens: fifteenPercent,
      recentDialogueTokens: fifteenPercent,
      evidenceCardTokens: fifteenPercent,
      exactExcerptTokens: fifteenPercent,
      reasoningAndAnswerTokens,
      emergencyReserveTokens,
      normalWorkingSetTokens: fifteenPercent * 4,
      totalAllocatedTokens: safeCapacity,
      estimateKind: this.estimator.estimate('').estimateKind,
    };
  }

  private unknownWindowAllocation(): WorkingSetAllocation {
    const normalWorkingSetTokens =
      UNKNOWN_WINDOW_ALLOCATION.instructionsTokens
      + UNKNOWN_WINDOW_ALLOCATION.recentDialogueTokens
      + UNKNOWN_WINDOW_ALLOCATION.evidenceCardTokens
      + UNKNOWN_WINDOW_ALLOCATION.exactExcerptTokens;
    return {
      ...UNKNOWN_WINDOW_ALLOCATION,
      normalWorkingSetTokens,
      totalAllocatedTokens:
        normalWorkingSetTokens
        + UNKNOWN_WINDOW_ALLOCATION.reasoningAndAnswerTokens
        + UNKNOWN_WINDOW_ALLOCATION.emergencyReserveTokens,
      estimateKind: this.estimator.estimate('').estimateKind,
    };
  }

  private rebalanceForControlOverage(
    base: WorkingSetAllocation,
    requiredControlTokens: number,
  ): WorkingSetAllocation {
    if (requiredControlTokens <= base.instructionsTokens) return base;
    let remaining = requiredControlTokens - base.instructionsTokens;
    let exactExcerptTokens = base.exactExcerptTokens;
    let evidenceCardTokens = base.evidenceCardTokens;
    let recentDialogueTokens = base.recentDialogueTokens;
    [exactExcerptTokens, remaining] = subtractUpTo(exactExcerptTokens, remaining);
    [evidenceCardTokens, remaining] = subtractUpTo(evidenceCardTokens, remaining);
    [recentDialogueTokens] = subtractUpTo(recentDialogueTokens, remaining);
    const normalWorkingSetTokens =
      requiredControlTokens + recentDialogueTokens + evidenceCardTokens + exactExcerptTokens;
    return {
      ...base,
      instructionsTokens: requiredControlTokens,
      recentDialogueTokens,
      evidenceCardTokens,
      exactExcerptTokens,
      normalWorkingSetTokens,
      totalAllocatedTokens:
        normalWorkingSetTokens
        + base.reasoningAndAnswerTokens
        + base.emergencyReserveTokens,
    };
  }

  private select(
    candidates: WorkingSetCandidate[],
    budget: number,
    kind: 'dialogue' | 'card' | 'excerpt',
  ): SelectedCandidates {
    const selected: WorkingSetCandidate[] = [];
    let tokens = 0;
    for (const candidate of [...candidates].sort(compareCandidates)) {
      const formatted = kind === 'dialogue'
        ? candidate.content
        : formatUntrustedEvidence(candidate, kind);
      const cost = this.estimator.estimate(formatted).tokens;
      if (cost > budget - tokens) continue;
      selected.push(candidate);
      tokens += cost;
    }
    return { items: selected, tokens };
  }

  private countAll(values: string[]): number {
    return values.reduce((sum, value) => sum + this.estimator.estimate(value).tokens, 0);
  }
}

export function buildWorkingSetRepresentation(
  requiredControlItems: string[],
  selected: WorkingSetSelection,
): {
  content: string;
  requiredControl: string;
  recentDialogue: string;
  evidenceCards: string;
  exactExcerpts: string;
} {
  const requiredControl = requiredControlItems.join('\n');
  const recentDialogue = selected.recentDialogue.map((item) => item.content).join('\n');
  const evidenceCards = selected.evidenceCards
    .map((item) => formatUntrustedEvidence(item, 'card')).join('\n');
  const exactExcerpts = selected.exactExcerpts
    .map((item) => formatUntrustedEvidence(item, 'excerpt')).join('\n');
  const sections = [
    ['REQUIRED CONTROL', requiredControl],
    ['RECENT DIALOGUE AND ACTIVE TASK', recentDialogue],
    ['EVIDENCE CARDS', evidenceCards],
    ['EXACT EXCERPTS', exactExcerpts],
  ] as const;
  return {
    content: sections.filter(([, content]) => content.length > 0)
      .map(([title, content]) => `## ${title}\n${content}`).join('\n\n'),
    requiredControl,
    recentDialogue,
    evidenceCards,
    exactExcerpts,
  };
}

function emptyRenderAccounting(
  estimateKind: WorkingSetAllocation['estimateKind'],
): WorkingSetRenderAccounting {
  return {
    totalTokens: 0,
    structuralOverheadTokens: 0,
    estimateKind,
    sectionTokens: {
      requiredControl: 0,
      recentDialogue: 0,
      evidenceCards: 0,
      exactExcerpts: 0,
    },
  };
}

export function formatUntrustedEvidence(
  candidate: WorkingSetCandidate,
  kind: 'card' | 'excerpt',
): string {
  const label = kind === 'card' ? 'EVIDENCE CARD' : 'EXACT EXCERPT';
  const disclosure = candidate.captureCompleteness === 'complete'
    ? ''
    : `\nLimitation: ${candidate.disclosure?.trim() || defaultDisclosure(candidate.captureCompleteness)}`;
  return [
    `[BEGIN UNTRUSTED ${label} ${candidate.id}]`,
    candidate.content,
    disclosure,
    `[END UNTRUSTED ${label} ${candidate.id}]`,
  ].filter(Boolean).join('\n');
}

function defaultDisclosure(completeness: Exclude<EvidenceCaptureCompleteness, 'complete'>): string {
  return completeness === 'bounded'
    ? 'Only a bounded portion of the source was captured.'
    : 'Only source metadata was captured.';
}

function compareCandidates(left: WorkingSetCandidate, right: WorkingSetCandidate): number {
  const scoreDifference = candidateScore(right) - candidateScore(left);
  if (scoreDifference !== 0) return scoreDifference;
  const recencyDifference = right.createdAt - left.createdAt;
  if (recencyDifference !== 0) return recencyDifference;
  return left.id.localeCompare(right.id);
}

function candidateScore(candidate: WorkingSetCandidate): number {
  return (candidate.explicitUserReference ? 10_000 : 0)
    + (candidate.hasUnresolvedContradiction ? 5_000 : 0)
    + (candidate.failedVerification ? 4_000 : 0)
    + Math.max(0, candidate.activeTaskEntityMatches ?? 0) * 100
    + (candidate.exactExcerptStillNeeded ? 50 : 0)
    + (candidate.priorCitationUse ? 20 : 0)
    + Math.max(0, candidate.relevanceScore ?? 0);
}

function subtractUpTo(value: number, amount: number): [number, number] {
  const removed = Math.min(value, amount);
  return [value - removed, amount - removed];
}

function selectCapacity(
  input: WorkingSetPlanInput,
  requiredControlTokens: number,
  disclosures: string[],
): number | undefined {
  const capacity = validOptionalCapacity(input.capacityTokens, 'WORKING_SET_CAPACITY_INVALID');
  const larger = validOptionalCapacity(
    input.largerModelCapacityTokens,
    'WORKING_SET_LARGER_CAPACITY_INVALID',
  );
  if (
    capacity !== undefined
    && larger !== undefined
    && larger > capacity
    && requiredControlTokens > Math.floor(capacity * 0.3)
  ) {
    disclosures.push('Working set routed to an available larger provider window.');
    return larger;
  }
  return capacity;
}

function validOptionalCapacity(value: number | undefined, code: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}
