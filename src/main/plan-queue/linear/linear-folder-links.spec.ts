import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanQueueLinearFolderLink, PlanQueueLinearProject } from '@contracts/schemas/plan-queue';
import { LinearFolderLinkService, realLinearFolderLinkDependencies, type LinearFolderLinkDependencies } from './linear-folder-links';

const project = (id: string, name = `Project ${id}`, teamKey = 'COM'): PlanQueueLinearProject => ({ id, name, teamId: `team-${teamKey}`, teamKey });
const link = (folder: string, ...projects: PlanQueueLinearProject[]): PlanQueueLinearFolderLink => ({
  folder,
  privateProject: null,
  clientProjects: projects,
});

/** A pretend disk: which folders exist, which Git project each is in, and where a link really points. */
interface World {
  dirs: Set<string>;
  tops: Map<string, string>;
  real: Map<string, string>;
  /** Held until released, so a test can pause a save part-way through its checks. */
  gates: Map<string, Promise<void>>;
  topCalls: string[];
}

/** Two top-level project folders, each the top of its own Git project. */
function worldWith(...repos: string[]): World {
  return {
    dirs: new Set(repos),
    tops: new Map(repos.map((repo) => [repo, repo])),
    real: new Map(),
    gates: new Map(),
    topCalls: [],
  };
}

function setup(world: World, initial: PlanQueueLinearFolderLink[] = []) {
  const store = { current: initial, writes: [] as PlanQueueLinearFolderLink[][], failWrite: false };
  const deps: LinearFolderLinkDependencies = {
    readLinks: () => store.current,
    saveLinks: (links) => {
      if (store.failWrite) throw new Error('The settings file could not be written.');
      store.current = links;
      store.writes.push(links);
    },
    isDirectory: async (folder) => world.dirs.has(folder),
    topFolderOf: async (folder) => {
      world.topCalls.push(folder);
      await world.gates.get(folder);
      const top = world.tops.get(folder);
      if (!top) throw new Error('fatal: not a git repository');
      return top;
    },
    realPathOf: async (folder) => world.real.get(folder) ?? folder,
  };
  return { store, service: new LinearFolderLinkService(deps) };
}

const reasons = (result: Awaited<ReturnType<LinearFolderLinkService['save']>>) => (result.saved ? [] : result.refused);

describe('saving the links', () => {
  it('accepts one folder with a private project and two client projects, and saves exactly that', async () => {
    const world = worldWith('/work/shop');
    const { service, store } = setup(world);
    const row: PlanQueueLinearFolderLink = {
      folder: '/work/shop',
      privateProject: project('P-JAM-1', 'Shop private', 'JAM'),
      clientProjects: [project('P-COM-1', 'Shop site'), project('P-COM-2', 'Shop app')],
    };
    const result = await service.save([row]);
    expect(result).toEqual({ saved: true, links: [row] });
    expect(store.current).toEqual([row]);
    expect(store.writes).toHaveLength(1);
  });

  it('saves an empty list, which removes every link', async () => {
    const { service, store } = setup(worldWith('/work/shop'), [link('/work/shop', project('P-1'))]);
    await expect(service.save([])).resolves.toEqual({ saved: true, links: [] });
    expect(store.current).toEqual([]);
  });

  it('refuses a folder that is not there, and names it', async () => {
    const { service, store } = setup(worldWith());
    const result = await service.save([link('/work/gone', project('P-1'))]);
    expect(reasons(result)).toEqual([{ index: 0, reason: 'There is no folder at /work/gone on this computer.' }]);
    expect(store.writes).toEqual([]);
  });

  it('refuses a folder that is not a Git project', async () => {
    const world = worldWith();
    world.dirs.add('/work/plain');
    const { service, store } = setup(world);
    const result = await service.save([link('/work/plain', project('P-1'))]);
    expect(reasons(result)).toEqual([{ index: 0, reason: '/work/plain is not part of a Git project, so no runs can start there.' }]);
    expect(store.writes).toEqual([]);
  });

  it('refuses a folder inside a project and names the top folder', async () => {
    const world = worldWith('/work/shop');
    world.dirs.add('/work/shop/packages');
    world.tops.set('/work/shop/packages', '/work/shop');
    const { service, store } = setup(world);
    const result = await service.save([link('/work/shop/packages', project('P-1'))]);
    expect(reasons(result)).toEqual([{
      index: 0,
      reason: "/work/shop/packages is a folder inside the project at /work/shop. Link the project's top folder instead.",
    }]);
    expect(store.writes).toEqual([]);
  });

  it('refuses the same folder twice in two spellings', async () => {
    const world = worldWith('/work/shop');
    world.dirs.add('/work//shop/');
    world.tops.set('/work//shop/', '/work/shop');
    const { service, store } = setup(world);
    const result = await service.save([link('/work/shop', project('P-1')), link('/work//shop/', project('P-2'))]);
    expect(reasons(result)).toEqual([{ index: 1, reason: 'Each folder can be linked once.' }]);
    expect(store.writes).toEqual([]);
  });

  it('refuses one project in two folders', async () => {
    const world = worldWith('/work/shop', '/work/blog');
    const { service, store } = setup(world);
    const result = await service.save([link('/work/shop', project('P-1', 'Shared')), link('/work/blog', project('P-1', 'Shared'))]);
    expect(reasons(result)).toEqual([{ index: 1, reason: 'The Linear project "Shared" can be linked to one folder only.' }]);
    expect(store.writes).toEqual([]);
  });

  it('refuses an entry with no project', async () => {
    const { service, store } = setup(worldWith('/work/shop'));
    const result = await service.save([{ folder: '/work/shop', privateProject: null, clientProjects: [] }]);
    expect(reasons(result)).toEqual([{ index: 0, reason: 'Link at least one Linear project to the folder.' }]);
    expect(store.writes).toEqual([]);
  });

  it('refuses a row that is not a link at all, in plain words', async () => {
    const { service } = setup(worldWith('/work/shop'));
    const result = await service.save(['/work/shop']);
    expect(reasons(result)).toHaveLength(1);
    expect(reasons(result)[0].index).toBe(0);
    expect(reasons(result)[0].reason).toMatch(/^This row is incomplete/);
  });

  it('refuses a list of more than 100 folders as a whole', async () => {
    const { service } = setup(worldWith());
    const result = await service.save(Array.from({ length: 101 }, () => null));
    expect(reasons(result).some((row) => row.index === null && /at most 100/.test(row.reason))).toBe(true);
  });

  it('a refused row saves nothing at all, even when the other rows are good', async () => {
    const world = worldWith('/work/shop');
    const before = [link('/work/shop', project('P-OLD'))];
    const { service, store } = setup(world, before);
    const result = await service.save([link('/work/shop', project('P-1')), link('/work/gone', project('P-2'))]);
    expect(reasons(result)).toEqual([{ index: 1, reason: 'There is no folder at /work/gone on this computer.' }]);
    expect(store.writes).toEqual([]);
    expect(store.current).toBe(before);
  });

  it('gives a reason for every refused row, not only the first', async () => {
    const world = worldWith('/work/shop');
    const { service } = setup(world);
    const result = await service.save([link('/work/gone-1', project('P-1')), link('/work/shop', project('P-2')), link('/work/gone-2', project('P-3'))]);
    expect(reasons(result).map((row) => row.index)).toEqual([0, 2]);
  });
});

describe('saving twice, and a save that does not finish', () => {
  it('two saves in a row keep the last, each fully checked against the disk, one after the other', async () => {
    const world = worldWith('/work/shop', '/work/blog');
    let release!: () => void;
    world.gates.set('/work/shop', new Promise<void>((resolve) => { release = resolve; }));
    const first = [link('/work/shop', project('P-1'))];
    const second = [link('/work/blog', project('P-2'))];
    const { service, store } = setup(world);

    const savingFirst = service.save(first);
    const savingSecond = service.save(second);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The second save has not started checking: it waits for the first to finish.
    expect(world.topCalls).toEqual(['/work/shop']);
    expect(store.current).toEqual([]);

    release();
    await Promise.all([savingFirst, savingSecond]);
    expect(world.topCalls).toEqual(['/work/shop', '/work/blog']);
    expect(store.writes).toEqual([first, second]);
    expect(store.current).toEqual(second);
  });

  it('a second save is still checked on its own: the first being good does not excuse it', async () => {
    const world = worldWith('/work/shop');
    const { service, store } = setup(world);
    const [good, bad] = await Promise.all([
      service.save([link('/work/shop', project('P-1'))]),
      service.save([link('/work/gone', project('P-2'))]),
    ]);
    expect(good.saved).toBe(true);
    expect(bad.saved).toBe(false);
    expect(store.current).toEqual([link('/work/shop', project('P-1'))]);
  });

  it('a reader in the middle of a save sees the old list whole, and then the new list whole', async () => {
    const world = worldWith('/work/shop', '/work/old');
    let release!: () => void;
    world.gates.set('/work/shop', new Promise<void>((resolve) => { release = resolve; }));
    const old = [link('/work/old', project('P-OLD'))];
    const next = [link('/work/shop', project('P-1'), project('P-2'))];
    const { service } = setup(world, old);

    const saving = service.save(next);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await service.readAll()).map((reading) => reading.link)).toEqual(old);
    release();
    await saving;
    expect((await service.readAll()).map((reading) => reading.link)).toEqual(next);
  });

  it('a save stopped before the settings write leaves the old list', async () => {
    const world = worldWith('/work/shop');
    const old = [link('/work/shop', project('P-OLD'))];
    const { service, store } = setup(world, old);
    store.failWrite = true;
    await expect(service.save([link('/work/shop', project('P-1'))])).rejects.toThrow('could not be written');
    expect(store.current).toBe(old);
    expect(store.writes).toEqual([]);
  });

  it('a save that never finishes its checks writes nothing, and a failed save does not block the next', async () => {
    const world = worldWith('/work/shop');
    world.gates.set('/work/shop', new Promise<void>(() => undefined));
    const old = [link('/work/shop', project('P-OLD'))];
    const { service, store } = setup(world, old);
    void service.save([link('/work/shop', project('P-1'))]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.current).toBe(old);
    expect(store.writes).toEqual([]);

    const other = setup(worldWith('/work/shop'));
    other.store.failWrite = true;
    await expect(other.service.save([link('/work/shop', project('P-1'))])).rejects.toThrow();
    other.store.failWrite = false;
    await expect(other.service.save([link('/work/shop', project('P-2'))])).resolves.toMatchObject({ saved: true });
  });
});

describe('using a link', () => {
  const shop = link('/work/shop', project('P-SHOP', 'Shop site'));
  const blog = link('/work/blog', project('P-BLOG', 'Blog site'), project('P-BLOG-2', 'Blog app'));

  it('returns the linked projects of a folder that is still the top of a Git project', async () => {
    const { service } = setup(worldWith('/work/shop', '/work/blog'), [shop, blog]);
    await expect(service.readForFolder('/work/blog')).resolves.toEqual({
      status: 'linked',
      folder: '/work/blog',
      privateProject: null,
      clientProjects: blog.clientProjects,
    });
  });

  it('never returns a project that is not linked to the folder asked about', async () => {
    const { service } = setup(worldWith('/work/shop', '/work/blog'), [shop, blog]);
    const reading = await service.readForFolder('/work/shop');
    expect(reading).toMatchObject({ status: 'linked' });
    expect(JSON.stringify(reading)).not.toContain('P-BLOG');
  });

  it('says so, and returns no project, for a folder with no link', async () => {
    const { service } = setup(worldWith('/work/shop', '/work/other'), [shop]);
    await expect(service.readForFolder('/work/other')).resolves.toEqual({ status: 'none', folder: '/work/other' });
  });

  it('finds a link by a differently spelled path, and by a path that reaches the same folder through a link', async () => {
    const world = worldWith('/work/shop');
    world.real.set('/work/alias', '/work/shop');
    const { service } = setup(world, [shop]);
    await expect(service.readForFolder('/work//shop/')).resolves.toMatchObject({ status: 'linked', folder: '/work/shop' });
    await expect(service.readForFolder('/work/alias')).resolves.toMatchObject({ status: 'linked', folder: '/work/shop' });
  });

  it('refuses a saved link whose folder was deleted since, with its reason and no projects', async () => {
    const world = worldWith('/work/shop');
    const { service } = setup(world, [shop]);
    world.dirs.delete('/work/shop');
    const reading = await service.readForFolder('/work/shop');
    expect(reading).toEqual({ status: 'broken', folder: '/work/shop', reason: 'There is no folder at /work/shop on this computer.' });
    expect(JSON.stringify(reading)).not.toContain('P-SHOP');
  });

  it('refuses a saved link whose folder was turned into a plain folder', async () => {
    const world = worldWith('/work/shop');
    const { service } = setup(world, [shop]);
    world.tops.delete('/work/shop');
    await expect(service.readForFolder('/work/shop')).resolves.toMatchObject({
      status: 'broken',
      reason: '/work/shop is not part of a Git project, so no runs can start there.',
    });
  });

  it('refuses a saved link whose folder became a folder inside another project', async () => {
    const world = worldWith('/work/shop');
    const { service } = setup(world, [shop]);
    world.tops.set('/work/shop', '/work');
    await expect(service.readForFolder('/work/shop')).resolves.toMatchObject({ status: 'broken', reason: expect.stringContaining('inside the project at /work') });
  });

  it('checks again each time it is used, so a repaired folder works at once', async () => {
    const world = worldWith('/work/shop');
    const { service } = setup(world, [shop]);
    world.dirs.delete('/work/shop');
    expect((await service.readForFolder('/work/shop')).status).toBe('broken');
    world.dirs.add('/work/shop');
    expect((await service.readForFolder('/work/shop')).status).toBe('linked');
  });

  it('reads every saved link with its live state, marking the broken ones', async () => {
    const world = worldWith('/work/shop');
    const { service } = setup(world, [shop, blog]);
    const readings = await service.readAll();
    expect(readings.map((reading) => [reading.link.folder, reading.broken === null])).toEqual([
      ['/work/shop', true],
      ['/work/blog', false],
    ]);
  });
});

describe('with a real disk and real Git', () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'pq-links-'))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function realService() {
    const store = { current: [] as PlanQueueLinearFolderLink[] };
    const service = new LinearFolderLinkService(realLinearFolderLinkDependencies({
      readLinks: () => store.current,
      saveLinks: (links) => { store.current = links; },
    }));
    return { service, store };
  }

  it('accepts a project top folder, and refuses a plain folder, a folder inside it and a missing one', async () => {
    const shop = join(root, 'shop');
    mkdirSync(join(shop, 'packages'), { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: shop });
    const plain = join(root, 'plain');
    mkdirSync(plain);
    const { service, store } = realService();

    const refused = await service.save([
      link(join(shop, 'packages'), project('P-1')),
      link(plain, project('P-2')),
      link(join(root, 'missing'), project('P-3')),
    ]);
    expect(reasons(refused).map((row) => row.index)).toEqual([0, 1, 2]);
    expect(reasons(refused)[0].reason).toContain(`inside the project at ${shop}`);
    expect(store.current).toEqual([]);

    await expect(service.save([link(shop, project('P-1'))])).resolves.toMatchObject({ saved: true });
  });

  it('turns a saved link into a broken one when its folder stops being a project', async () => {
    const shop = join(root, 'shop');
    mkdirSync(shop);
    execFileSync('git', ['init', '--quiet'], { cwd: shop });
    const { service } = realService();
    await service.save([link(shop, project('P-1'))]);
    expect((await service.readForFolder(shop)).status).toBe('linked');
    rmSync(join(shop, '.git'), { recursive: true, force: true });
    expect((await service.readForFolder(shop)).status).toBe('broken');
  });

  it('treats a link to a project folder and the folder itself as one folder', async () => {
    const shop = join(root, 'shop');
    mkdirSync(shop);
    execFileSync('git', ['init', '--quiet'], { cwd: shop });
    const alias = join(root, 'alias');
    symlinkSync(shop, alias);
    const { service } = realService();
    const result = await service.save([link(shop, project('P-1')), link(alias, project('P-2'))]);
    expect(reasons(result)).toEqual([{ index: 1, reason: 'This is the same folder as row 1. Each folder can be linked once.' }]);
  });
});
