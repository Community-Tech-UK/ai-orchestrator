import { runAutomaticStartup } from './automatic-startup';
import { reserveHelperAdmission } from './helper-admission';

export async function runHelperStartup<T extends { id: string }>(
  remote: boolean,
  create: () => Promise<T>,
  terminate: (id: string) => Promise<void>,
): Promise<T> {
  const release = reserveHelperAdmission(remote);
  try {
    return await runAutomaticStartup(async startup => {
      const instance = await create();
      startup.register(instance, () => terminate(instance.id));
      return instance;
    });
  } finally { release(); }
}
