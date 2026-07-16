export interface ContextEvidenceDiagnosticEvent {
  conversationId: string;
  provider?: string;
  evidenceId?: string;
  classification: 'capture' | 'retrieval' | 'pressure' | 'recovery' | 'integrity' | 'deletion';
  occupancyUsed?: number;
  occupancyTotal?: number;
  cumulativeTokens?: number;
  storedEvidenceBytes?: number;
  evidenceRecordCount?: number;
  evidenceCardCount?: number;
  exactExcerptCount?: number;
  modelRequestCount?: number;
  toolCallCount?: number;
  toolResultBytes?: number;
  thresholdCode?: string | null;
  actionCode?: string | null;
  proofStage?: string | null;
  durationMs?: number | null;
  failureCode?: string | null;
  createdAt: number;
}

export type PrivacySafeContextEvidenceDiagnosticEvent = Omit<
  ContextEvidenceDiagnosticEvent,
  'conversationId' | 'provider' | 'evidenceId'
>;

const ALLOWED_FIELDS = new Set<keyof ContextEvidenceDiagnosticEvent>([
  'conversationId', 'provider', 'evidenceId', 'classification', 'occupancyUsed',
  'occupancyTotal', 'cumulativeTokens', 'storedEvidenceBytes', 'evidenceRecordCount',
  'evidenceCardCount', 'exactExcerptCount', 'modelRequestCount', 'toolCallCount',
  'toolResultBytes', 'thresholdCode', 'actionCode', 'proofStage', 'durationMs',
  'failureCode', 'createdAt',
]);
const COUNT_FIELDS = [
  'occupancyUsed', 'occupancyTotal', 'cumulativeTokens', 'storedEvidenceBytes',
  'evidenceRecordCount', 'evidenceCardCount', 'exactExcerptCount', 'modelRequestCount',
  'toolCallCount', 'toolResultBytes', 'createdAt',
] as const satisfies readonly (keyof ContextEvidenceDiagnosticEvent)[];
const CODE_FIELDS = [
  'thresholdCode', 'actionCode', 'proofStage', 'failureCode',
] as const satisfies readonly (keyof ContextEvidenceDiagnosticEvent)[];
const DIAGNOSTIC_CODE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Bounded, content-free runtime diagnostics with an identifier-free export mode. */
export class ContextEvidenceDiagnostics {
  private readonly events: ContextEvidenceDiagnosticEvent[] = [];

  constructor(private readonly maxEvents = 1000) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
      throw new Error('CONTEXT_EVIDENCE_DIAGNOSTIC_LIMIT_INVALID');
    }
  }

  record(event: ContextEvidenceDiagnosticEvent): void {
    if (Object.keys(event).some((field) => !ALLOWED_FIELDS.has(
      field as keyof ContextEvidenceDiagnosticEvent,
    ))) {
      throw new Error('CONTEXT_EVIDENCE_DIAGNOSTIC_FIELD_NOT_ALLOWED');
    }
    if (!validDiagnosticValues(event)) {
      throw new Error('CONTEXT_EVIDENCE_DIAGNOSTIC_VALUE_INVALID');
    }
    this.events.push(structuredClone(event));
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  snapshot(): ContextEvidenceDiagnosticEvent[] {
    return this.events.map((event) => structuredClone(event));
  }

  export(options: { privacySafe: true }): PrivacySafeContextEvidenceDiagnosticEvent[];
  export(options: { privacySafe: false }): ContextEvidenceDiagnosticEvent[];
  export(options: { privacySafe: boolean }): (
    ContextEvidenceDiagnosticEvent | PrivacySafeContextEvidenceDiagnosticEvent
  )[] {
    if (!options.privacySafe) return this.snapshot();
    return this.events.map((event) => Object.fromEntries(
      Object.entries(event).filter(([field]) => (
        field !== 'conversationId' && field !== 'provider' && field !== 'evidenceId'
      )),
    ) as PrivacySafeContextEvidenceDiagnosticEvent);
  }
}

function validDiagnosticValues(event: ContextEvidenceDiagnosticEvent): boolean {
  for (const field of COUNT_FIELDS) {
    const value = event[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) return false;
  }
  if (event.durationMs !== undefined && event.durationMs !== null
    && (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0)) {
    return false;
  }
  if (event.occupancyUsed !== undefined && event.occupancyTotal !== undefined
    && event.occupancyUsed > event.occupancyTotal) {
    return false;
  }
  for (const field of CODE_FIELDS) {
    const value = event[field];
    if (value !== undefined && value !== null
      && (typeof value !== 'string' || !DIAGNOSTIC_CODE.test(value))) {
      return false;
    }
  }
  return true;
}
