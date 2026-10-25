import { getWorkAdmission } from './work-admission';

interface Consult { interrupt(): void; settled: Promise<void> }
const active = new Set<Consult>();

/** Consult adapters live outside the instance list, so restart pause tracks them explicitly. */
export function trackConsult(interrupt: () => void): () => void {
  let finish!: () => void;
  const consult: Consult = { interrupt, settled: new Promise(resolve => { finish = resolve; }) };
  active.add(consult);
  return () => { active.delete(consult); finish(); };
}

export async function pauseConsults(): Promise<void> {
  const running = [...active];
  for (const consult of running) consult.interrupt();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(running.map(consult => consult.settled)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('A review is still stopping. Try Pause for restart again.')), 30_000);
        timer.unref();
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function waitForConsult(): Promise<void> { await getWorkAdmission().wait('consult'); }

/** Reserve before the first await so pause also sees admission and setup waits. */
export async function runTrackedConsult<T>(work: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
  const abort = new AbortController();
  const signal = abort.signal;
  const abortFromExternal = (): void => abort.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const untrack = trackConsult(() => abort.abort());
  try {
    // Pre-cancelled headless calls still produce their existing cancellation result.
    if (!externalSignal?.aborted) {
      await getWorkAdmission().wait('consult', {}, signal);
      signal.throwIfAborted();
      const decision = getWorkAdmission().check('consult');
      if (!decision.allowed) throw new Error(decision.detail);
    }
    return await work(signal);
  } finally { externalSignal?.removeEventListener('abort', abortFromExternal); untrack(); }
}
