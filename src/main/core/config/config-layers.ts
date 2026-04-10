import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../logging/logger';

const logger = getLogger('ConfigLayers');

type ConfigRecord = Record<string, unknown>;

export interface ConfigLayerInput {
  system: ConfigRecord;
  project: ConfigRecord;
  user: ConfigRecord;
}

/**
 * Deep merge config layers with precedence: user > project > system.
 * Arrays are replaced (not merged). Objects are deep merged.
 * Primitives from higher-precedence layers override lower ones.
 */
export function mergeConfigLayers(layers: ConfigLayerInput): ConfigRecord {
  return deepMerge(deepMerge(layers.system, layers.project), layers.user);
}

function deepMerge(base: ConfigRecord, override: ConfigRecord): ConfigRecord {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as ConfigRecord, value as ConfigRecord);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Discover config files in standard locations.
 */
export function discoverConfigFiles(options: {
  homeDir: string | null;
  projectDir: string;
}): { system: string | null; project: string | null; user: string | null } {
  const projectConfig = path.join(options.projectDir, '.orchestrator', 'config.json');
  const userConfig = options.homeDir
    ? path.join(options.homeDir, '.orchestrator', 'config.json')
    : null;

  return {
    system: null, // System defaults are hardcoded, not from a file
    project: fs.existsSync(projectConfig) ? projectConfig : null,
    user: userConfig && fs.existsSync(userConfig) ? userConfig : null,
  };
}

/**
 * Load and merge all config layers for a given project directory.
 */
export function loadMergedConfig(options: {
  homeDir: string | null;
  projectDir: string;
  systemDefaults: ConfigRecord;
}): ConfigRecord {
  const files = discoverConfigFiles(options);
  const project = loadJsonFile(files.project);
  const user = loadJsonFile(files.user);

  return mergeConfigLayers({
    system: options.systemDefaults,
    project,
    user,
  });
}

function loadJsonFile(filePath: string | null): ConfigRecord {
  if (!filePath) return {};
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ConfigRecord;
    }
    logger.warn(`Config file is not an object: ${filePath}`);
    return {};
  } catch (err) {
    logger.warn(`Failed to load config file: ${filePath}`, { error: String(err) });
    return {};
  }
}
