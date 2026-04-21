#!/usr/bin/env node

const { spawnSync } = require('child_process');

function getElectronBuilderArgs(platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return ['--mac', '--config.mac.identity=null'];
    case 'win32':
      return ['--win', '--config.win.signAndEditExecutable=false'];
    case 'linux':
      return ['--linux'];
    default:
      throw new Error(`Unsupported platform for localbuild: ${platform}`);
  }
}

function getNpmInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && npmExecPath.endsWith('.js')) {
    return {
      command: process.execPath,
      args: [npmExecPath],
    };
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [],
  };
}

function runLocalBuild(platform = process.platform) {
  const builderArgs = getElectronBuilderArgs(platform);
  const npmInvocation = getNpmInvocation();
  const result = spawnSync(
    npmInvocation.command,
    [...npmInvocation.args, 'run', 'electron:build', '--', ...builderArgs],
    {
    stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

if (require.main === module) {
  runLocalBuild();
}

module.exports = {
  getElectronBuilderArgs,
  getNpmInvocation,
  runLocalBuild,
};
