import { ownedByEngine } from './engine-ownership';
import { getWorkAdmission, type AdmissionContext, type WorkAdmission } from './work-admission';

const RUNNING_STATUSES = ['busy', 'processing', 'thinking_deeply', 'initializing', 'waiting_for_input', 'waiting_for_permission'];

/**
 * A session that counts against the helper-agent limit while it runs: one another session started (it has a parent),
 * or one `run_on_node` sent to another computer (no parent, but it records its spawn depth). Engine work is exempt.
 */
export function isRunningHelperAgent(instance: { id: string; status: string; parentId?: string | null; metadata?: Record<string, unknown> }): boolean {
  return Boolean(instance.parentId || typeof instance.metadata?.['spawnDepth'] === 'number')
    && !ownedByEngine(instance) && RUNNING_STATUSES.includes(instance.status);
}

const pending = new WeakMap<WorkAdmission, { count: number }>();

/** `remote` is work the engines own (never counted); `otherComputer` is a helper on another computer (counted). */
export function reserveHelperAdmission(placement: Pick<AdmissionContext, 'remote' | 'otherComputer'>, admission: WorkAdmission = getWorkAdmission()): () => void {
  let state = pending.get(admission);
  if (!state) {
    const created = { count: 0 };
    pending.set(admission, created);
    admission.registerCounter('helper-agent', () => created.count);
    state = created;
  }
  const decision = admission.check('helper-agent', placement);
  if (!decision.allowed) throw new Error(decision.detail);
  if (placement.remote) return () => undefined;
  state.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.count--;
    admission.notifyChanged();
  };
}
