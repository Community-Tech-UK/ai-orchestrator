import { runAutomaticStartup } from './automatic-startup';
import { reserveHelperAdmission } from './helper-admission';
import type { AdmissionContext } from './work-admission';

export async function runHelperStartup<T extends { id: string }>(
  placement: Pick<AdmissionContext, 'remote' | 'otherComputer'>,
  create: () => Promise<T>,
  terminate: (id: string) => Promise<void>,
): Promise<T> {
  const release = reserveHelperAdmission(placement);
  try {
    return await runAutomaticStartup(async startup => {
      const instance = await create();
      startup.register(instance, () => terminate(instance.id));
      return instance;
    });
  } finally { release(); }
}
