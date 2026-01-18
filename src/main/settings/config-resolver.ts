/**
 * Config Resolver - Resolves hierarchical configuration (project > user > default)
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  AppSettings,
  DEFAULT_SETTINGS,
  ProjectConfig,
  ResolvedConfig,
  PROJECT_CONFIG_FILE,
  mergeConfigs,
} from '../../shared/types/settings.types';
import { getSettingsManager } from './settings-manager';

// Cache for project configs to avoid repeated file reads
const projectConfigCache = new Map<string, { config: ProjectConfig; mtime: number }>();

/**
 * Find the project config file by searching up the directory tree
 */
export function findProjectConfigPath(startDir: string): string | null {
  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    const configPath = path.join(currentDir, PROJECT_CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
    currentDir = path.dirname(currentDir);
  }

  return null;
}

/**
 * Load project config from a file path
 */
export function loadProjectConfig(configPath: string): ProjectConfig | null {
  try {
    // Check cache first
    const cached = projectConfigCache.get(configPath);
    const stats = fs.statSync(configPath);
    const mtime = stats.mtimeMs;

    if (cached && cached.mtime === mtime) {
      return cached.config;
    }

    // Read and parse the config file
    const content = fs.readFileSync(configPath, 'utf-8');

    // Support JSONC (JSON with comments) by stripping comments
    const jsonContent = stripJsonComments(content);
    const config = JSON.parse(jsonContent) as ProjectConfig;

    // Cache the result
    projectConfigCache.set(configPath, { config, mtime });

    return config;
  } catch (error) {
    console.error(`Failed to load project config from ${configPath}:`, error);
    return null;
  }
}

/**
 * Strip JSON comments (// and /* *\/) for JSONC support
 */
function stripJsonComments(content: string): string {
  // Remove single-line comments
  let result = content.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  return result;
}

/**
 * Save project config to a file
 */
export function saveProjectConfig(configPath: string, config: ProjectConfig): boolean {
  try {
    const content = JSON.stringify(config, null, 2);
    fs.writeFileSync(configPath, content, 'utf-8');

    // Update cache
    const stats = fs.statSync(configPath);
    projectConfigCache.set(configPath, { config, mtime: stats.mtimeMs });

    return true;
  } catch (error) {
    console.error(`Failed to save project config to ${configPath}:`, error);
    return false;
  }
}

/**
 * Create a new project config file
 */
export function createProjectConfig(projectDir: string, config?: Partial<ProjectConfig>): string {
  const configPath = path.join(projectDir, PROJECT_CONFIG_FILE);

  const defaultConfig: ProjectConfig = {
    name: path.basename(projectDir),
    description: '',
    settings: {},
    commands: [],
    ignorePatterns: [],
    ...config,
  };

  saveProjectConfig(configPath, defaultConfig);
  return configPath;
}

/**
 * Resolve configuration for a specific working directory
 * Merges: default < user < project
 */
export function resolveConfig(workingDir?: string): ResolvedConfig {
  const settingsManager = getSettingsManager();
  const userSettings = settingsManager.getAll();

  // Find project config if working directory is provided
  let projectConfig: ProjectConfig | undefined;
  let projectPath: string | undefined;

  if (workingDir) {
    const configPath = findProjectConfigPath(workingDir);
    if (configPath) {
      projectConfig = loadProjectConfig(configPath) || undefined;
      projectPath = path.dirname(configPath);
    }
  }

  // Merge configurations
  const resolved = mergeConfigs(
    DEFAULT_SETTINGS,
    userSettings,
    projectConfig?.settings
  );

  return {
    ...resolved,
    projectConfig,
    projectPath,
  };
}

/**
 * Clear the project config cache
 */
export function clearConfigCache(): void {
  projectConfigCache.clear();
}

/**
 * Clear cache for a specific path
 */
export function clearConfigCacheFor(configPath: string): void {
  projectConfigCache.delete(configPath);
}

/**
 * Watch a project config file for changes
 */
export function watchProjectConfig(
  configPath: string,
  callback: (config: ProjectConfig | null) => void
): () => void {
  const watcher = fs.watch(configPath, (eventType) => {
    if (eventType === 'change') {
      clearConfigCacheFor(configPath);
      const config = loadProjectConfig(configPath);
      callback(config);
    }
  });

  return () => watcher.close();
}
