/** Cancel only the captured form owners; a later turn may reuse an RPC key. */
export async function cancelAcpElicitations<T extends { key: string }>(
  requests: Map<string, T>,
  sendCancel: (request: T) => Promise<void>,
  resolved: (key: string) => void,
  retireBeforeWrite: boolean,
): Promise<void> {
  const pending = [...requests.values()];
  const retire = (): void => {
    for (const request of pending) {
      if (requests.get(request.key) !== request) continue;
      requests.delete(request.key);
      resolved(request.key);
    }
  };
  // Timeouts lose answer ownership even if cancellation can never drain stdin.
  if (retireBeforeWrite) retire();
  await Promise.all(pending.map(sendCancel));
  retire();
}
