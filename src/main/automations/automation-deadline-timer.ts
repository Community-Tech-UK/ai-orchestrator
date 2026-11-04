/** Node timers overflow beyond about 25 days; migrated limits may legitimately be longer. */
export function scheduleAutomationDeadline(deadline: number, now: () => number, expire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    timer = setTimeout(() => { if (now() >= deadline) expire(); else arm(); }, Math.max(0, Math.min(2_147_000_000, deadline - now())));
    timer.unref?.();
  };
  arm();
  return () => clearTimeout(timer);
}
