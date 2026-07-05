export function isRemoteNodeOnline(node: { connected?: boolean; status: string }): boolean {
  return node.connected ?? node.status === 'connected';
}
