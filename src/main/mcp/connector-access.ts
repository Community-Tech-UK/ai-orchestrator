/** Per-spawn connector grants complement the authenticated instance capability. */
export class ConnectorAccessRegistry {
  private readonly grants = new Map<string, Set<string>>();
  grant(instanceId: string, connectorIds: string[]): void {
    this.grants.set(instanceId, new Set(connectorIds));
  }
  assert(instanceId: string, connectorId: string): void {
    if (!this.grants.get(instanceId)?.has(connectorId))
      throw new Error('This connector was not given to this session.');
  }
  clear(): void {
    this.grants.clear();
  }
}
export const connectorAccessRegistry = new ConnectorAccessRegistry();
