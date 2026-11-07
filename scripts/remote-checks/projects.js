'use strict';
/**
 * The only other repositories that may go to the test machine. A repository is matched by its
 * real git folder, so a copy with the same name doesn't count, and its Plan Queue worktrees do.
 * Nothing under ~/work/ebrd ever goes. Adding a repository here needs James to name it, and a
 * matching recipe in remote-run.sh, which refuses anything it doesn't know.
 *
 * Undistilled and 12steps were measured on 7 November 2026 and stay on the Mac: see "Stage 5"
 * in docs/plans/2026-11-06-offload-heavy-work_plan*.md.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanGitEnv } = require('./snapshot');

/** `folder` is where the runner lives, relative to the repository. `sends` limits uncommitted files to the folders the tests read. */
const PROJECTS = [
  {
    id: 'work-finding',
    repository: 'work/communitytech/work-finding',
    suites: [
      {
        suite: 'desk',
        folder: 'apps/desk',
        nodeFile: 'apps/desk/.nvmrc',
        lockFile: 'apps/desk/package-lock.json',
        sends: ['apps'],
        // Run from `folder` after a run elsewhere, as remote-run.sh leaves these out.
        macOnly: ['scripts/run-tests-quiet.mjs', 'test/unit/panelLayoutCss.test.ts'],
      },
    ],
  },
];

function gitPath(cwd, ...args) {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', ...args], {
    cwd, encoding: 'utf8', env: cleanGitEnv(), stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Finds the recipe for a folder, or null when it isn't a listed repository or a folder with a
 * suite in it. `home` is only ever different in tests.
 */
function findProject(cwd, home = os.homedir()) {
  let commonDir;
  let root;
  try {
    commonDir = fs.realpathSync(gitPath(cwd, '--git-common-dir'));
    root = fs.realpathSync(gitPath(cwd, '--show-toplevel'));
  } catch {
    return null;
  }
  const realHome = fs.realpathSync(home);
  const project = PROJECTS.find(entry => path.join(realHome, entry.repository, '.git') === commonDir);
  if (!project) return null;
  const here = path.relative(root, fs.realpathSync(cwd)) || '.';
  const suite = project.suites.find(entry => entry.folder === here);
  return suite ? { id: project.id, root, ...suite } : null;
}

module.exports = { PROJECTS, findProject };
