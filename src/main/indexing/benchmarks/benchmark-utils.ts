/**
 * Benchmark Utilities
 *
 * Utilities for generating synthetic test data and collecting performance metrics
 * for codebase indexing benchmarks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkMetrics {
  /** Duration in milliseconds */
  durationMs: number;
  /** Memory usage in bytes at start */
  memoryAtStart: MemorySnapshot;
  /** Memory usage in bytes at end */
  memoryAtEnd: MemorySnapshot;
  /** Peak memory during operation (if tracked) */
  peakMemory?: number;
  /** Operations per second */
  opsPerSecond?: number;
  /** Items processed */
  itemsProcessed?: number;
}

export interface MemorySnapshot {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
}

export interface PercentileStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  stdDev: number;
}

export interface SyntheticFileOptions {
  /** File type: 'typescript' | 'javascript' | 'python' */
  language: 'typescript' | 'javascript' | 'python';
  /** Target file size in bytes (approximate) */
  targetSize?: number;
  /** Number of functions to generate */
  functionCount?: number;
  /** Number of classes to generate */
  classCount?: number;
  /** Number of imports to generate */
  importCount?: number;
  /** Whether to include JSDoc/docstrings */
  includeComments?: boolean;
}

export interface SyntheticCodebaseOptions {
  /** Number of files to generate */
  fileCount: number;
  /** Distribution of languages (percentages) */
  languageDistribution?: {
    typescript?: number;
    javascript?: number;
    python?: number;
  };
  /** Average file size in bytes */
  avgFileSize?: number;
  /** Directory depth (max nesting level) */
  maxDepth?: number;
  /** Files per directory (average) */
  filesPerDir?: number;
}

// ============================================================================
// Memory Utilities
// ============================================================================

/**
 * Take a snapshot of current memory usage.
 */
export function getMemorySnapshot(): MemorySnapshot {
  const mem = process.memoryUsage();
  return {
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    rss: mem.rss,
  };
}

/**
 * Force garbage collection if available.
 * Note: Requires --expose-gc flag.
 */
export function forceGC(): void {
  if (global.gc) {
    global.gc();
  }
}

/**
 * Calculate memory delta between two snapshots.
 */
export function getMemoryDelta(start: MemorySnapshot, end: MemorySnapshot): MemorySnapshot {
  return {
    heapUsed: end.heapUsed - start.heapUsed,
    heapTotal: end.heapTotal - start.heapTotal,
    external: end.external - start.external,
    rss: end.rss - start.rss,
  };
}

/**
 * Format bytes to human readable string.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Math.abs(bytes);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  const sign = bytes < 0 ? '-' : '';
  return `${sign}${value.toFixed(2)} ${units[unitIndex]}`;
}

// ============================================================================
// Timing Utilities
// ============================================================================

/**
 * Measure execution time of an async function.
 */
export async function measureAsync<T>(
  fn: () => Promise<T>
): Promise<{ result: T; metrics: BenchmarkMetrics }> {
  forceGC();
  const memoryAtStart = getMemorySnapshot();
  const startTime = performance.now();

  const result = await fn();

  const endTime = performance.now();
  const memoryAtEnd = getMemorySnapshot();

  return {
    result,
    metrics: {
      durationMs: endTime - startTime,
      memoryAtStart,
      memoryAtEnd,
    },
  };
}

/**
 * Measure execution time of a sync function.
 */
export function measureSync<T>(fn: () => T): { result: T; metrics: BenchmarkMetrics } {
  forceGC();
  const memoryAtStart = getMemorySnapshot();
  const startTime = performance.now();

  const result = fn();

  const endTime = performance.now();
  const memoryAtEnd = getMemorySnapshot();

  return {
    result,
    metrics: {
      durationMs: endTime - startTime,
      memoryAtStart,
      memoryAtEnd,
    },
  };
}

/**
 * Run a benchmark multiple times and collect statistics.
 */
export async function runBenchmarkIterations<T>(
  fn: () => Promise<T>,
  iterations: number = 10,
  warmupIterations: number = 2
): Promise<{ stats: PercentileStats; allMetrics: BenchmarkMetrics[] }> {
  // Warmup runs
  for (let i = 0; i < warmupIterations; i++) {
    await fn();
  }

  // Actual benchmark runs
  const allMetrics: BenchmarkMetrics[] = [];
  for (let i = 0; i < iterations; i++) {
    const { metrics } = await measureAsync(fn);
    allMetrics.push(metrics);
  }

  const durations = allMetrics.map((m) => m.durationMs);
  const stats = calculatePercentiles(durations);

  return { stats, allMetrics };
}

/**
 * Calculate percentile statistics from an array of numbers.
 */
export function calculatePercentiles(values: number[]): PercentileStats {
  if (values.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      stdDev: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;

  // Calculate standard deviation
  const squareDiffs = sorted.map((value) => Math.pow(value - mean, 2));
  const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / sorted.length;
  const stdDev = Math.sqrt(avgSquareDiff);

  const percentile = (p: number) => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  };

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median: percentile(50),
    p50: percentile(50),
    p75: percentile(75),
    p90: percentile(90),
    p95: percentile(95),
    p99: percentile(99),
    stdDev,
  };
}

// ============================================================================
// Synthetic Code Generation
// ============================================================================

const TYPESCRIPT_IMPORTS = [
  "import { Component, OnInit } from '@angular/core';",
  "import { Injectable } from '@angular/core';",
  "import * as fs from 'fs';",
  "import * as path from 'path';",
  "import { EventEmitter } from 'events';",
  "import type { Database } from 'better-sqlite3';",
  "import { Observable, Subject } from 'rxjs';",
  "import { map, filter, switchMap } from 'rxjs/operators';",
];

const JAVASCRIPT_IMPORTS = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const { EventEmitter } = require('events');",
  "import express from 'express';",
  "import { createServer } from 'http';",
];

const PYTHON_IMPORTS = [
  'import os',
  'import sys',
  'import json',
  'from typing import List, Dict, Optional',
  'from dataclasses import dataclass',
  'import asyncio',
  'from pathlib import Path',
];

/**
 * Generate a random identifier name.
 */
function generateIdentifier(prefix: string = 'item'): string {
  const suffixes = [
    'Handler',
    'Manager',
    'Service',
    'Controller',
    'Repository',
    'Factory',
    'Builder',
    'Processor',
    'Validator',
    'Transformer',
  ];
  const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
  const id = Math.floor(Math.random() * 10000);
  return `${prefix}${suffix}${id}`;
}

/**
 * Generate synthetic TypeScript code.
 */
export function generateTypeScriptFile(options: Partial<SyntheticFileOptions> = {}): string {
  const {
    functionCount = 5,
    classCount = 2,
    importCount = 3,
    includeComments = true,
  } = options;

  const lines: string[] = [];

  // Add imports
  const shuffledImports = [...TYPESCRIPT_IMPORTS].sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(importCount, shuffledImports.length); i++) {
    lines.push(shuffledImports[i]);
  }
  lines.push('');

  // Generate interfaces
  const interfaceName = generateIdentifier('I');
  if (includeComments) {
    lines.push('/**');
    lines.push(` * Interface for ${interfaceName} configuration.`);
    lines.push(' */');
  }
  lines.push(`export interface ${interfaceName} {`);
  lines.push('  id: string;');
  lines.push('  name: string;');
  lines.push('  enabled: boolean;');
  lines.push('  config?: Record<string, unknown>;');
  lines.push('}');
  lines.push('');

  // Generate classes
  for (let c = 0; c < classCount; c++) {
    const className = generateIdentifier('');
    if (includeComments) {
      lines.push('/**');
      lines.push(` * ${className} handles business logic for the application.`);
      lines.push(' */');
    }
    lines.push(`export class ${className} {`);
    lines.push(`  private data: Map<string, unknown> = new Map();`);
    lines.push('');

    // Constructor
    lines.push(`  constructor(private config: ${interfaceName}) {`);
    lines.push('    this.initialize();');
    lines.push('  }');
    lines.push('');

    // Add methods
    for (let m = 0; m < Math.ceil(functionCount / classCount); m++) {
      const methodName = generateIdentifier('process').replace(/[A-Z][a-z]+\d+$/, '');
      if (includeComments) {
        lines.push('  /**');
        lines.push(`   * ${methodName} processes the given input.`);
        lines.push('   * @param input - The input data to process');
        lines.push('   * @returns The processed result');
        lines.push('   */');
      }
      lines.push(`  async ${methodName}(input: string): Promise<string> {`);
      lines.push('    const result = input.toUpperCase();');
      lines.push('    this.data.set(input, result);');
      lines.push('    return result;');
      lines.push('  }');
      lines.push('');
    }

    lines.push('  private initialize(): void {');
    lines.push('    console.log("Initializing...");');
    lines.push('  }');
    lines.push('}');
    lines.push('');
  }

  // Generate standalone functions
  for (let f = 0; f < functionCount; f++) {
    const funcName = generateIdentifier('calculate').replace(/[A-Z][a-z]+\d+$/, '');
    if (includeComments) {
      lines.push('/**');
      lines.push(` * ${funcName} performs a calculation.`);
      lines.push(' */');
    }
    lines.push(`export function ${funcName}(value: number): number {`);
    lines.push('  const multiplier = Math.PI;');
    lines.push('  return value * multiplier;');
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate synthetic JavaScript code.
 */
export function generateJavaScriptFile(options: Partial<SyntheticFileOptions> = {}): string {
  const {
    functionCount = 5,
    classCount = 2,
    importCount = 3,
    includeComments = true,
  } = options;

  const lines: string[] = [];

  // Add imports
  const shuffledImports = [...JAVASCRIPT_IMPORTS].sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(importCount, shuffledImports.length); i++) {
    lines.push(shuffledImports[i]);
  }
  lines.push('');

  // Generate classes
  for (let c = 0; c < classCount; c++) {
    const className = generateIdentifier('');
    if (includeComments) {
      lines.push('/**');
      lines.push(` * ${className} class for handling operations.`);
      lines.push(' */');
    }
    lines.push(`class ${className} {`);

    // Constructor
    lines.push('  constructor(config) {');
    lines.push('    this.config = config;');
    lines.push('    this.data = new Map();');
    lines.push('  }');
    lines.push('');

    // Add methods
    for (let m = 0; m < Math.ceil(functionCount / classCount); m++) {
      const methodName = generateIdentifier('handle').replace(/[A-Z][a-z]+\d+$/, '');
      if (includeComments) {
        lines.push('  /**');
        lines.push(`   * ${methodName} handles the request.`);
        lines.push('   * @param {Object} req - Request object');
        lines.push('   * @returns {Promise<Object>} Response');
        lines.push('   */');
      }
      lines.push(`  async ${methodName}(req) {`);
      lines.push('    const result = { success: true, data: req };');
      lines.push('    this.data.set(Date.now(), result);');
      lines.push('    return result;');
      lines.push('  }');
      lines.push('');
    }

    lines.push('}');
    lines.push('');
    lines.push(`module.exports = { ${className} };`);
    lines.push('');
  }

  // Generate standalone functions
  for (let f = 0; f < functionCount; f++) {
    const funcName = generateIdentifier('process').replace(/[A-Z][a-z]+\d+$/, '');
    if (includeComments) {
      lines.push('/**');
      lines.push(` * ${funcName} processes data.`);
      lines.push(` * @param {*} data - Input data`);
      lines.push(' */');
    }
    lines.push(`function ${funcName}(data) {`);
    lines.push('  return JSON.stringify(data);');
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate synthetic Python code.
 */
export function generatePythonFile(options: Partial<SyntheticFileOptions> = {}): string {
  const {
    functionCount = 5,
    classCount = 2,
    importCount = 3,
    includeComments = true,
  } = options;

  const lines: string[] = [];

  // Add imports
  const shuffledImports = [...PYTHON_IMPORTS].sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(importCount, shuffledImports.length); i++) {
    lines.push(shuffledImports[i]);
  }
  lines.push('');
  lines.push('');

  // Generate classes
  for (let c = 0; c < classCount; c++) {
    const className = generateIdentifier('');
    if (includeComments) {
      lines.push(`class ${className}:`);
      lines.push(`    """${className} handles business logic."""`);
    } else {
      lines.push(`class ${className}:`);
    }
    lines.push('');

    // Constructor
    lines.push('    def __init__(self, config: Dict):');
    if (includeComments) {
      lines.push('        """Initialize the instance."""');
    }
    lines.push('        self.config = config');
    lines.push('        self.data = {}');
    lines.push('');

    // Add methods
    for (let m = 0; m < Math.ceil(functionCount / classCount); m++) {
      const methodName = generateIdentifier('process')
        .replace(/[A-Z][a-z]+\d+$/, '')
        .toLowerCase();
      lines.push(`    async def ${methodName}(self, value: str) -> str:`);
      if (includeComments) {
        lines.push(`        """Process the given value."""`);
      }
      lines.push('        result = value.upper()');
      lines.push('        self.data[value] = result');
      lines.push('        return result');
      lines.push('');
    }
  }

  // Generate standalone functions
  for (let f = 0; f < functionCount; f++) {
    const funcName = generateIdentifier('calculate')
      .replace(/[A-Z][a-z]+\d+$/, '')
      .toLowerCase();
    lines.push(`def ${funcName}(value: int) -> float:`);
    if (includeComments) {
      lines.push(`    """Calculate result from value."""`);
    }
    lines.push('    import math');
    lines.push('    return value * math.pi');
    lines.push('');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a synthetic file based on language.
 */
export function generateSyntheticFile(options: SyntheticFileOptions): string {
  switch (options.language) {
    case 'typescript':
      return generateTypeScriptFile(options);
    case 'javascript':
      return generateJavaScriptFile(options);
    case 'python':
      return generatePythonFile(options);
    default:
      return generateTypeScriptFile(options);
  }
}

/**
 * Generate file content of approximately the target size.
 */
export function generateFileOfSize(
  language: 'typescript' | 'javascript' | 'python',
  targetSizeBytes: number
): string {
  // Start with base content
  let content = generateSyntheticFile({
    language,
    functionCount: 3,
    classCount: 1,
    includeComments: true,
  });

  // If content is smaller than target, keep adding
  while (content.length < targetSizeBytes) {
    const additionalContent = generateSyntheticFile({
      language,
      functionCount: 2,
      classCount: 1,
      includeComments: true,
    });
    content += '\n' + additionalContent;
  }

  // Trim to approximate target size
  if (content.length > targetSizeBytes) {
    content = content.substring(0, targetSizeBytes);
  }

  return content;
}

// ============================================================================
// Synthetic Codebase Generation
// ============================================================================

/**
 * Create a synthetic codebase in a temporary directory.
 */
export async function createSyntheticCodebase(
  options: SyntheticCodebaseOptions
): Promise<{ rootPath: string; cleanup: () => Promise<void> }> {
  const {
    fileCount,
    languageDistribution = { typescript: 0.6, javascript: 0.3, python: 0.1 },
    avgFileSize = 2000,
    maxDepth = 4,
    filesPerDir = 10,
  } = options;

  // Create temp directory
  const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bench-codebase-'));

  // Calculate files per language
  const tsCount = Math.floor(fileCount * (languageDistribution.typescript || 0));
  const jsCount = Math.floor(fileCount * (languageDistribution.javascript || 0));
  const pyCount = fileCount - tsCount - jsCount;

  const files: Array<{ lang: 'typescript' | 'javascript' | 'python'; ext: string }> = [
    ...Array(tsCount).fill({ lang: 'typescript' as const, ext: '.ts' }),
    ...Array(jsCount).fill({ lang: 'javascript' as const, ext: '.js' }),
    ...Array(pyCount).fill({ lang: 'python' as const, ext: '.py' }),
  ];

  // Shuffle files
  files.sort(() => Math.random() - 0.5);

  // Generate directory structure
  const directories = generateDirectoryStructure(fileCount, maxDepth, filesPerDir);

  // Create directories
  for (const dir of directories) {
    await fs.promises.mkdir(path.join(rootPath, dir), { recursive: true });
  }

  // Create files
  let dirIndex = 0;
  for (let i = 0; i < files.length; i++) {
    const { lang, ext } = files[i];
    const dir = directories[dirIndex % directories.length];

    // Vary file size around average
    const sizeVariation = 0.5 + Math.random(); // 0.5 to 1.5x
    const targetSize = Math.floor(avgFileSize * sizeVariation);

    const content = generateFileOfSize(lang, targetSize);
    const fileName = `file_${i}${ext}`;
    const filePath = path.join(rootPath, dir, fileName);

    await fs.promises.writeFile(filePath, content, 'utf-8');

    // Move to next directory periodically
    if ((i + 1) % filesPerDir === 0) {
      dirIndex++;
    }
  }

  // Cleanup function
  const cleanup = async () => {
    await fs.promises.rm(rootPath, { recursive: true, force: true });
  };

  return { rootPath, cleanup };
}

/**
 * Generate a directory structure for the codebase.
 */
function generateDirectoryStructure(
  fileCount: number,
  maxDepth: number,
  filesPerDir: number
): string[] {
  const directories: string[] = ['src'];
  const subdirs = ['components', 'services', 'utils', 'models', 'lib', 'helpers', 'core'];

  const numDirs = Math.ceil(fileCount / filesPerDir);

  for (let i = 0; i < numDirs; i++) {
    const depth = Math.floor(Math.random() * maxDepth) + 1;
    const parts: string[] = ['src'];

    for (let d = 0; d < depth; d++) {
      const subdir = subdirs[Math.floor(Math.random() * subdirs.length)];
      parts.push(`${subdir}${d > 0 ? d : ''}`);
    }

    directories.push(parts.join('/'));
  }

  return [...new Set(directories)];
}

/**
 * Create a single large file for testing.
 */
export async function createLargeFile(
  sizeBytes: number,
  language: 'typescript' | 'javascript' | 'python' = 'typescript'
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const ext = language === 'typescript' ? '.ts' : language === 'javascript' ? '.js' : '.py';
  const filePath = path.join(os.tmpdir(), `large-file-${Date.now()}${ext}`);

  const content = generateFileOfSize(language, sizeBytes);
  await fs.promises.writeFile(filePath, content, 'utf-8');

  const cleanup = async () => {
    await fs.promises.unlink(filePath).catch(() => {});
  };

  return { filePath, cleanup };
}

// ============================================================================
// Benchmark Reporting
// ============================================================================

/**
 * Format benchmark results as a table.
 */
export function formatBenchmarkTable(
  results: Array<{ name: string; stats: PercentileStats; itemCount?: number }>
): string {
  const headers = ['Benchmark', 'Min', 'Mean', 'p50', 'p95', 'p99', 'Max', 'Ops/sec'];
  const rows: string[][] = [headers];

  for (const result of results) {
    const { name, stats, itemCount } = result;
    const opsPerSec = itemCount ? ((itemCount / stats.mean) * 1000).toFixed(2) : '-';

    rows.push([
      name,
      `${stats.min.toFixed(2)}ms`,
      `${stats.mean.toFixed(2)}ms`,
      `${stats.p50.toFixed(2)}ms`,
      `${stats.p95.toFixed(2)}ms`,
      `${stats.p99.toFixed(2)}ms`,
      `${stats.max.toFixed(2)}ms`,
      opsPerSec,
    ]);
  }

  // Calculate column widths
  const colWidths = headers.map((_, i) => Math.max(...rows.map((row) => row[i].length)));

  // Format rows
  const separator = colWidths.map((w) => '-'.repeat(w + 2)).join('+');
  const formatRow = (row: string[]) =>
    row.map((cell, i) => ` ${cell.padEnd(colWidths[i])} `).join('|');

  return [
    separator,
    formatRow(rows[0]),
    separator,
    ...rows.slice(1).map(formatRow),
    separator,
  ].join('\n');
}

/**
 * Assert that a benchmark meets performance targets.
 */
export function assertPerformanceTarget(
  stats: PercentileStats,
  targets: { maxP95Ms?: number; maxMeanMs?: number; minOpsPerSec?: number; itemCount?: number }
): { passed: boolean; message: string } {
  const messages: string[] = [];
  let passed = true;

  if (targets.maxP95Ms !== undefined && stats.p95 > targets.maxP95Ms) {
    passed = false;
    messages.push(`p95 ${stats.p95.toFixed(2)}ms exceeds target ${targets.maxP95Ms}ms`);
  }

  if (targets.maxMeanMs !== undefined && stats.mean > targets.maxMeanMs) {
    passed = false;
    messages.push(`mean ${stats.mean.toFixed(2)}ms exceeds target ${targets.maxMeanMs}ms`);
  }

  if (targets.minOpsPerSec !== undefined && targets.itemCount !== undefined) {
    const actualOpsPerSec = (targets.itemCount / stats.mean) * 1000;
    if (actualOpsPerSec < targets.minOpsPerSec) {
      passed = false;
      messages.push(
        `ops/sec ${actualOpsPerSec.toFixed(2)} below target ${targets.minOpsPerSec}`
      );
    }
  }

  return {
    passed,
    message: passed ? 'All targets met' : messages.join('; '),
  };
}
