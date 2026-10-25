import { getWorkAdmission, type WorkAdmission } from './work-admission';

const pending = new WeakMap<WorkAdmission, { count: number }>();

export function reserveHelperAdmission(remote: boolean, admission: WorkAdmission = getWorkAdmission()): () => void {
  let state = pending.get(admission);
  if (!state) {
    const created = { count: 0 };
    pending.set(admission, created);
    admission.registerCounter('helper-agent', () => created.count);
    state = created;
  }
  const decision = admission.check('helper-agent', { remote });
  if (!decision.allowed) throw new Error(decision.detail);
  if (remote) return () => undefined;
  state.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.count--;
    admission.notifyChanged();
  };
}
