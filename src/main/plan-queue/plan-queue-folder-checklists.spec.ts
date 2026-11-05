import { describe, expect, it } from 'vitest';
import type { PlanQueueFolderChecklist } from '@contracts/schemas/plan-queue';
import { resolveRunGates, savedChecklistFor } from './plan-queue-folder-checklists';

const defaults = { verifierGates: ['npm run lint'], postMergeGate: ['npx tsc --noEmit'] };
const saved: PlanQueueFolderChecklist = { folder: '/work/shop', verifierGates: ['make check'], postMergeGate: ['make types'] };

describe('savedChecklistFor', () => {
  it('finds a folder whatever its trailing slash, and nothing for another folder', () => {
    expect(savedChecklistFor([saved], '/work/shop')).toBe(saved);
    expect(savedChecklistFor([saved], '/work/shop/')).toBe(saved);
    expect(savedChecklistFor([saved], '/work/shop-two')).toBeNull();
    expect(savedChecklistFor([saved], '/work/shop/sub')).toBeNull();
    expect(savedChecklistFor([], '/work/shop')).toBeNull();
  });
  it('prefers an entry for the folder the run started in, and otherwise uses the top of its Git project', () => {
    const sub: PlanQueueFolderChecklist = { folder: '/work/shop/sub', verifierGates: ['make sub'], postMergeGate: [] };
    expect(savedChecklistFor([saved, sub], '/work/shop', '/work/shop/sub')).toBe(sub);
    expect(savedChecklistFor([saved, sub], '/work/shop', '/work/shop/other')).toBe(saved);
    expect(savedChecklistFor([sub], '/work/shop', '/work/shop/other')).toBeNull();
    expect(savedChecklistFor([sub], '/work/shop', '/work/shop/sub/')).toBe(sub);
  });
  it('finds a folder written with dot segments, repeated slashes or the other slash', () => {
    expect(savedChecklistFor([saved], '/work/base/../shop')).toBe(saved);
    expect(savedChecklistFor([saved], '/work//shop/./')).toBe(saved);
    expect(savedChecklistFor([{ ...saved, folder: 'C:\\work\\shop' }], 'C:/work/shop/')).toMatchObject({ verifierGates: ['make check'] });
  });
});

describe('resolveRunGates', () => {
  it('uses the defaults when nothing is saved and the caller passed nothing', () => {
    expect(resolveRunGates(defaults, undefined, null)).toEqual({ ...defaults, callerGatesSetAside: false });
  });

  it('lets a caller name gates when nothing is saved, including an empty list', () => {
    expect(resolveRunGates(defaults, { verifierGates: ['x'] }, null)).toEqual({ verifierGates: ['x'], postMergeGate: defaults.postMergeGate, callerGatesSetAside: false });
    expect(resolveRunGates(defaults, { postMergeGate: [] }, null)).toMatchObject({ postMergeGate: [] });
  });

  it('uses the saved lists over the defaults and over anything the caller passed', () => {
    expect(resolveRunGates(defaults, undefined, saved)).toEqual({ verifierGates: ['make check'], postMergeGate: ['make types'], callerGatesSetAside: false });
    expect(resolveRunGates(defaults, { verifierGates: ['echo hi'], postMergeGate: ['rm -rf x'] }, saved))
      .toEqual({ verifierGates: ['make check'], postMergeGate: ['make types'], callerGatesSetAside: true });
    expect(resolveRunGates(defaults, { postMergeGate: [] }, saved)).toMatchObject({ postMergeGate: ['make types'], callerGatesSetAside: true });
  });

  it('does not report a set-aside when the caller passed exactly the saved gates', () => {
    expect(resolveRunGates(defaults, { verifierGates: ['make check'] }, saved).callerGatesSetAside).toBe(false);
  });

  it('copies the saved lists so a run cannot change the setting', () => {
    const gates = resolveRunGates(defaults, undefined, saved);
    expect(gates.verifierGates).not.toBe(saved.verifierGates);
  });
});
