export interface ServicePaths {
  configDir: string;
  configFile: string;
  binDir: string;
  binFile: string;
  currentBinLink: string;
  versionedBinDir: string;
  logDir: string;
  pluginDir: string;
}

type Platform = 'win32' | 'linux' | 'darwin';

export function servicePaths(platform: Platform = process.platform as Platform): ServicePaths {
  switch (platform) {
    case 'win32': {
      const binDir = 'C:\\Program Files\\Orchestrator\\bin';
      const currentBinLink = `${binDir}\\current`;
      return {
        configDir: 'C:\\ProgramData\\Orchestrator',
        configFile: 'C:\\ProgramData\\Orchestrator\\worker-node.json',
        binDir,
        binFile: `${currentBinLink}\\worker-agent.exe`,
        currentBinLink,
        versionedBinDir: `${binDir}\\versions`,
        logDir: 'C:\\ProgramData\\Orchestrator\\logs',
        pluginDir: 'C:\\ProgramData\\Orchestrator\\plugins',
      };
    }
    case 'linux': {
      const binDir = '/opt/orchestrator/bin';
      const currentBinLink = `${binDir}/current`;
      return {
        configDir: '/etc/orchestrator',
        configFile: '/etc/orchestrator/worker-node.json',
        binDir,
        binFile: `${currentBinLink}/worker-agent`,
        currentBinLink,
        versionedBinDir: `${binDir}/versions`,
        logDir: '/var/log/orchestrator',
        pluginDir: '/var/lib/orchestrator/plugins',
      };
    }
    case 'darwin': {
      const binDir = '/usr/local/opt/orchestrator/bin';
      const currentBinLink = `${binDir}/current`;
      return {
        configDir: '/Library/Application Support/Orchestrator',
        configFile: '/Library/Application Support/Orchestrator/worker-node.json',
        binDir,
        binFile: `${currentBinLink}/worker-agent`,
        currentBinLink,
        versionedBinDir: `${binDir}/versions`,
        logDir: '/Library/Logs/Orchestrator',
        pluginDir: '/Library/Application Support/Orchestrator/plugins',
      };
    }
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
