const HARNESS_SCOPES: Readonly<Record<string, string>> = {
  orchestrator: 'Harness',
  'orchestrator-bootstrap': 'Harness bootstrap',
  'orchestrator-codemem': 'Harness memory',
};

/** Keep persisted scope identifiers in payloads and Config; name their UI choices. */
export function mcpScopeLabel(scope: string | undefined): string {
  return scope ? HARNESS_SCOPES[scope] ?? scope : '';
}
