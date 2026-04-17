export interface ServicePaths {
  configDir: string;
  configFile: string;
  binDir: string;
  binFile: string;
  logDir: string;
  pluginDir: string;
}

type Platform = 'win32' | 'linux' | 'darwin';

export function servicePaths(platform: Platform = process.platform as Platform): ServicePaths {
  switch (platform) {
    case 'win32':
      return {
        configDir: 'C:\\ProgramData\\Orchestrator',
        configFile: 'C:\\ProgramData\\Orchestrator\\worker-node.json',
        binDir: 'C:\\Program Files\\Orchestrator\\bin',
        binFile: 'C:\\Program Files\\Orchestrator\\bin\\worker-agent.exe',
        logDir: 'C:\\ProgramData\\Orchestrator\\logs',
        pluginDir: 'C:\\ProgramData\\Orchestrator\\plugins',
      };
    case 'linux':
      return {
        configDir: '/etc/orchestrator',
        configFile: '/etc/orchestrator/worker-node.json',
        binDir: '/opt/orchestrator/bin',
        binFile: '/opt/orchestrator/bin/worker-agent',
        logDir: '/var/log/orchestrator',
        pluginDir: '/var/lib/orchestrator/plugins',
      };
    case 'darwin':
      return {
        configDir: '/Library/Application Support/Orchestrator',
        configFile: '/Library/Application Support/Orchestrator/worker-node.json',
        binDir: '/usr/local/opt/orchestrator/bin',
        binFile: '/usr/local/opt/orchestrator/bin/worker-agent',
        logDir: '/Library/Logs/Orchestrator',
        pluginDir: '/Library/Application Support/Orchestrator/plugins',
      };
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
