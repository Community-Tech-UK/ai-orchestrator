import {
  EvidenceCompareToolArgsSchema,
  EvidenceListToolArgsSchema,
  EvidenceReadToolArgsSchema,
  EvidenceSearchToolArgsSchema,
  EvidenceVerifyToolArgsSchema,
} from './orchestrator-evidence-tools';

export const EVIDENCE_RPC_SPECS = [
  { method: 'orchestrator_tools.evidence_list', toolName: 'evidence_list', schema: EvidenceListToolArgsSchema },
  { method: 'orchestrator_tools.evidence_search', toolName: 'evidence_search', schema: EvidenceSearchToolArgsSchema },
  { method: 'orchestrator_tools.evidence_read', toolName: 'evidence_read', schema: EvidenceReadToolArgsSchema },
  { method: 'orchestrator_tools.evidence_compare', toolName: 'evidence_compare', schema: EvidenceCompareToolArgsSchema },
  { method: 'orchestrator_tools.evidence_verify', toolName: 'evidence_verify', schema: EvidenceVerifyToolArgsSchema },
] as const;
