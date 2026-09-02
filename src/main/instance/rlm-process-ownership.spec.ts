import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import type { ContextWorkerInboundMsg } from './context-worker-protocol';

type IpcHandler = (event: unknown, payload?: unknown) => unknown | Promise<unknown>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  failHandleChannel: null as string | null,
  handleError: null as Error | null,
}));

const ownerImportProbe = vi.hoisted(() => ({
  contextManagerResolutions: 0,
  indexingServiceResolutions: 0,
  instanceContextResolutions: 0,
  unifiedControllerResolutions: 0,
  memoryBarrelResolutions: 0,
}));

const learningMocks = vi.hoisted(() => ({
  outcome: {
    getTopPatterns: vi.fn(() => []),
    recordOutcome: vi.fn(),
    getOutcome: vi.fn(),
    getRecentOutcomes: vi.fn(() => []),
    getExperience: vi.fn(),
    getAllExperiences: vi.fn(() => []),
    getInsights: vi.fn(() => []),
    getStats: vi.fn(),
    getTaskTypeStats: vi.fn(),
    rateOutcome: vi.fn(),
    configure: vi.fn(),
  },
  strategy: { getRecommendation: vi.fn(() => ({ confidence: 0 })) },
  enhancer: { enhance: vi.fn() },
  ab: {
    createExperiment: vi.fn(),
    updateExperiment: vi.fn(),
    deleteExperiment: vi.fn(),
    startExperiment: vi.fn(),
    pauseExperiment: vi.fn(),
    completeExperiment: vi.fn(),
    getExperiment: vi.fn(),
    listExperiments: vi.fn(() => []),
    getVariant: vi.fn(),
    recordOutcome: vi.fn(),
    getResults: vi.fn(() => []),
    getWinner: vi.fn(),
    getStats: vi.fn(),
    configure: vi.fn(),
  },
}));

const workerSideEventSources = vi.hoisted(() => {
  const makeEmitter = () => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
      emit(event: string, ...args: unknown[]): boolean {
        const eventListeners = listeners.get(event) ?? [];
        for (const listener of eventListeners) listener(...args);
        return eventListeners.length > 0;
      },
      on(event: string, listener: (...args: unknown[]) => void): void {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
    };
  };
  return {
    skillAttribution: makeEmitter(),
    wakeContext: makeEmitter(),
  };
});

const bootstrapFakes = vi.hoisted(() => {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const lane = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return lane;
    }),
    off: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener));
      return lane;
    }),
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
    indexCodebase: vi.fn(async () => ({
      filesIndexed: 0,
      chunksCreated: 0,
      tokensProcessed: 0,
      duration: 0,
      errors: [],
    })),
    indexFile: vi.fn(async () => undefined),
    cancelIndexCodebase: vi.fn(async () => undefined),
    getIndexCodebaseProgress: vi.fn(() => null),
    getStats: vi.fn(async () => ({ totalFiles: 0, totalChunks: 0, totalTokens: 0 })),
    clearLegacyCodebaseStore: vi.fn(async () => undefined),
    syncFiles: vi.fn(async () => ({ outcomes: [] })),
  };
  return {
    lane,
    memoryR1: new Proxy({}, { get: () => vi.fn() }),
    debate: new Proxy({}, { get: () => vi.fn() }),
    codemem: {
      indexWorkerGateway: {
        getIndexStatus: vi.fn(async () => null),
        cancelIndex: vi.fn(async () => undefined),
      },
    },
    codeRetrieval: { search: vi.fn(async () => []) },
    settingsValues: {
      autoTerminateIdleMinutes: 0,
      codebaseAutoIndexEnabled: true,
      defaultCli: 'claude',
      defaultFailoverProviders: [],
      defaultYoloMode: false,
      enableDiskStorage: false,
      outputBufferSize: 100,
      sessionFailoverMaxSwitches: 0,
      toolLoopAutoInterrupt: false,
    } as Record<string, unknown>,
  };
});

vi.mock('electron', () => ({
  app: {
    getName: () => 'Harness Test',
    getPath: () => '/tmp/aio-rlm-process-ownership',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      if (channel === electronMocks.failHandleChannel) throw electronMocks.handleError;
      electronMocks.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      electronMocks.handlers.delete(channel);
    }),
  },
}));

vi.mock('../rlm/context-manager', () => {
  ownerImportProbe.contextManagerResolutions += 1;
  throw new Error('main facade resolved the RLM context manager');
});

vi.mock('../memory/unified-controller', () => {
  ownerImportProbe.unifiedControllerResolutions += 1;
  throw new Error('main facade resolved unified memory');
});

vi.mock('../memory', () => {
  ownerImportProbe.memoryBarrelResolutions += 1;
  throw new Error('main facade resolved the memory barrel');
});

vi.mock('../indexing/indexing-service', () => {
  ownerImportProbe.indexingServiceResolutions += 1;
  throw new Error('Electron main resolved CodebaseIndexingService');
});

vi.mock('./instance-context', () => {
  ownerImportProbe.instanceContextResolutions += 1;
  throw new Error('Electron main resolved InstanceContextManager');
});

vi.mock('../learning/outcome-tracker', () => ({
  OutcomeTracker: { getInstance: () => learningMocks.outcome },
}));

vi.mock('../commands/command-manager', () => ({
  getCommandManager: () => ({ executeCommand: vi.fn(), parseCommand: vi.fn() }),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: (key: string) => bootstrapFakes.settingsValues[key],
    getAll: () => ({ ...bootstrapFakes.settingsValues }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }),
}));

vi.mock('../memory/r1-memory-manager', () => ({
  getMemoryManager: () => bootstrapFakes.memoryR1,
}));

vi.mock('../orchestration/debate-coordinator', () => ({
  getDebateCoordinator: () => bootstrapFakes.debate,
}));

vi.mock('../indexing/codebase-indexing-lane-gateway', () => ({
  getCodebaseIndexingLaneGateway: () => bootstrapFakes.lane,
}));

vi.mock('../codemem', () => ({
  getCodemem: () => bootstrapFakes.codemem,
  getCodeRetrievalService: () => bootstrapFakes.codeRetrieval,
  getCodememPrewarmCoordinator: () => ({ start: vi.fn(), hintActiveWorkspace: vi.fn() }),
}));

vi.mock('../learning/strategy-learner', () => ({
  StrategyLearner: { getInstance: () => learningMocks.strategy },
}));

vi.mock('../learning/prompt-enhancer', () => ({
  PromptEnhancer: { getInstance: () => learningMocks.enhancer },
}));

vi.mock('../learning/ab-testing', () => ({
  ABTestingEngine: { getInstance: () => learningMocks.ab },
}));

vi.mock('../ipc/model-discovery-ipc-handlers', () => ({
  registerModelDiscoveryHandlers: vi.fn(),
}));

vi.mock('../skills/skill-attribution-service', () => ({
  getSkillAttribution: () => workerSideEventSources.skillAttribution,
}));

vi.mock('../memory/wake-context-builder', () => ({
  getWakeContextBuilder: () => workerSideEventSources.wakeContext,
}));

vi.mock('./orchestration/fast-path-retriever', () => ({
  FastPathRetriever: class FastPathRetriever {},
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

interface RuntimeModuleReference {
  specifier: string;
  importedNames: string[];
  kind: 'dynamic-import' | 'export' | 'import' | 'import-equals' | 'require';
}

interface OwnerCallManifestEntry {
  role: string;
  file: string;
  callee: string;
  count: number;
}

const mainRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = resolve(mainRoot, '../..');
const processRoots = {
  'electron-main': resolve(mainRoot, 'main-process-entry.ts'),
  'context-worker': resolve(mainRoot, 'instance/context-worker-main.ts'),
  'indexing-lane': resolve(mainRoot, 'indexing/codebase-indexing-lane-main.ts'),
} as const;

function runtimeModuleReferences(
  sourceText: string,
  filePath = 'fixture.ts',
  checker?: ts.TypeChecker,
  programSourceFile?: ts.SourceFile,
): RuntimeModuleReference[] {
  const sourceFile = programSourceFile ?? ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const references: RuntimeModuleReference[] = [];

  const add = (
    specifier: ts.Expression | ts.ModuleReference | undefined,
    importedNames: string[],
    kind: RuntimeModuleReference['kind'],
  ): void => {
    if (specifier && ts.isStringLiteralLike(specifier) && importedNames.length > 0) {
      references.push({ specifier: specifier.text, importedNames, kind });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause) {
        add(node.moduleSpecifier, ['<side-effect>'], 'import');
      } else if (!clause.isTypeOnly) {
        const names: string[] = [];
        if (clause.name) names.push('default');
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          names.push('*');
        } else if (clause.namedBindings) {
          for (const element of clause.namedBindings.elements) {
            if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
          }
        }
        add(node.moduleSpecifier, names, 'import');
      }
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      const names = !node.exportClause
        ? ['*']
        : ts.isNamespaceExport(node.exportClause)
          ? ['*']
          : node.exportClause.elements
            .filter((element) => !element.isTypeOnly)
            .map((element) => (element.propertyName ?? element.name).text);
      add(node.moduleSpecifier, names, 'export');
    } else if (
      ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, [node.name.text], 'import-equals');
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (
        ts.isIdentifier(node.expression)
        && node.expression.text === 'require'
        && isCommonJsRequire(checker, node.expression)
      ) {
        add(argument, ['*'], 'require');
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(argument, ['*'], 'dynamic-import');
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
}

function isCommonJsRequire(
  checker: ts.TypeChecker | undefined,
  identifier: ts.Identifier,
): boolean {
  if (!checker) return true;
  const symbol = resolveAliasedSymbol(checker, checker.getSymbolAtLocation(identifier));
  if (!symbol) return false;
  return (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function listProductionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'testing') visit(absolutePath);
      } else if (
        entry.isFile()
        && extname(entry.name) === '.ts'
        && !entry.name.endsWith('.d.ts')
        && !entry.name.endsWith('.spec.ts')
        && !entry.name.endsWith('.test.ts')
      ) {
        files.push(absolutePath);
      }
    }
  };
  visit(root);
  return files.sort();
}

let compilerOptionsCache: ts.CompilerOptions | undefined;
let productionFilesCache: string[] | undefined;

function readCompilerOptions(): ts.CompilerOptions {
  if (compilerOptionsCache) return compilerOptionsCache;
  const configPath = resolve(projectRoot, 'tsconfig.electron.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  compilerOptionsCache = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot).options;
  return compilerOptionsCache;
}

function createOwnershipProgram(virtualSources: Record<string, string> = {}): ts.Program {
  const options = readCompilerOptions();
  const virtualFiles = new Map<string, string>(
    Object.entries(virtualSources).map(([name, source]) => [
      resolve(mainRoot, 'instance', name),
      source,
    ]),
  );
  const host = ts.createCompilerHost(options);
  const hostFileExists = host.fileExists.bind(host);
  const hostReadFile = host.readFile.bind(host);
  const hostGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => virtualFiles.has(resolve(fileName)) || hostFileExists(fileName);
  host.readFile = (fileName) => virtualFiles.get(resolve(fileName)) ?? hostReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const virtualSource = virtualFiles.get(resolve(fileName));
    return virtualSource === undefined
      ? hostGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, virtualSource, languageVersion, true, ts.ScriptKind.TS);
  };
  return ts.createProgram({
    rootNames: [
      ...(productionFilesCache ??= listProductionTypeScriptFiles(mainRoot)),
      ...virtualFiles.keys(),
    ],
    options,
    host,
  });
}

function resolvedRuntimeTarget(
  program: ts.Program,
  importer: string,
  specifier: string,
): string | null {
  const resolvedModule = ts.resolveModuleName(
    specifier,
    importer,
    program.getCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  if (resolvedModule && !resolvedModule.isExternalLibraryImport) {
    const target = resolve(resolvedModule.resolvedFileName);
    if (program.getSourceFile(target)) return target;
  }
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(importer), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]
    .find((candidate) => program.getSourceFile(candidate)) ?? null;
}

function runtimeClosure(program: ts.Program, root: string): Set<string> {
  const closure = new Set<string>();
  const pending = [resolve(root)];
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (!fileName || closure.has(fileName)) continue;
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) throw new Error(`Missing ownership root/module: ${fileName}`);
    closure.add(fileName);
    for (const reference of runtimeModuleReferences(
      sourceFile.text,
      fileName,
      program.getTypeChecker(),
      sourceFile,
    )) {
      const target = resolvedRuntimeTarget(program, fileName, reference.specifier);
      if (target && !closure.has(target)) pending.push(target);
    }
  }
  return closure;
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  const visited = new Set<ts.Symbol>();
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !visited.has(symbol)) {
    visited.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function directOwnerCalleeForSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  invocation: 'call' | 'new',
): string | null {
  const resolvedSymbol = resolveAliasedSymbol(checker, symbol);
  for (const declaration of resolvedSymbol?.declarations ?? []) {
    const file = relative(mainRoot, declaration.getSourceFile().fileName);
    if (
      invocation === 'new'
      && file === 'instance/instance-context.ts'
      && ts.isClassDeclaration(declaration)
      && declaration.name?.text === 'InstanceContextManager'
    ) {
      return 'new InstanceContextManager';
    }
    if (invocation !== 'call') continue;
    if (
      file === 'rlm/context-manager.ts'
      && ts.isFunctionDeclaration(declaration)
      && declaration.name?.text === 'getRLMContextManager'
    ) {
      return 'getRLMContextManager';
    }
    if (
      file === 'memory/unified-controller.ts'
      && ts.isFunctionDeclaration(declaration)
      && declaration.name?.text === 'getUnifiedMemory'
    ) {
      return 'getUnifiedMemory';
    }
    if (
      ts.isMethodDeclaration(declaration)
      && declaration.name.getText() === 'getInstance'
      && ts.isClassDeclaration(declaration.parent)
    ) {
      const className = declaration.parent.name?.text;
      if (file === 'rlm/context-manager.ts' && className === 'RLMContextManager') {
        return 'RLMContextManager.getInstance';
      }
      if (file === 'memory/unified-controller.ts' && className === 'UnifiedMemoryController') {
        return 'UnifiedMemoryController.getInstance';
      }
    }
  }
  return null;
}

function containingVariableDeclaration(node: ts.Node): ts.VariableDeclaration | null {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isVariableDeclaration(current)) return current;
    current = current.parent;
  }
  return null;
}

function unwrappedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function ownerCalleeForExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  invocation: 'call' | 'new',
  visited: Set<ts.Symbol>,
  atNode: ts.Node,
  diagnosticNode: ts.Node = atNode,
): string | null {
  const target = unwrappedExpression(expression);
  if (ts.isConditionalExpression(target)) {
    return mergeOwnerBranchValues(
      [target.whenTrue, target.whenFalse].map((branch) => ownerCalleeForExpression(
        checker,
        branch,
        invocation,
        new Set(visited),
        atNode,
        diagnosticNode,
      )),
      diagnosticNode,
    );
  }
  if (
    ts.isBinaryExpression(target)
    && (
      target.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || target.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    )
  ) {
    return mergeOwnerBranchValues(
      [target.left, target.right].map((branch) => ownerCalleeForExpression(
        checker,
        branch,
        invocation,
        new Set(visited),
        atNode,
        diagnosticNode,
      )),
      diagnosticNode,
    );
  }
  if (ts.isElementAccessExpression(target) && target.argumentExpression) {
    const propertyName = literalAccessName(target.argumentExpression);
    if (propertyName !== null) {
      const propertyOwner = ownerCalleeForPropertyValue(
        checker,
        target.expression,
        propertyName,
        invocation,
        new Set(visited),
        atNode,
        diagnosticNode,
      );
      if (propertyOwner) return propertyOwner;
    }
  }
  const symbolOwner = ownerCalleeForSymbol(
    checker,
    symbolForExpression(checker, target),
    invocation,
    new Set(visited),
    atNode,
    diagnosticNode,
  );
  return symbolOwner ?? ownerCalleeForCommonJsExpression(
    checker,
    target,
    invocation,
    visited,
    atNode,
  );
}

function throwAmbiguousOwnerValue(node: ts.Node): never {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  throw new Error(
    `Ambiguous owner alias value at ${relative(mainRoot, sourceFile.fileName)}:${line + 1}:${character + 1}`,
  );
}

function mergeOwnerBranchValues(values: (string | null)[], diagnosticNode: ts.Node): string | null {
  const owners = new Set(values.filter((value): value is string => value !== null));
  if (owners.size === 0) return null;
  if (owners.size === 1 && values.every((value) => value !== null)) {
    return owners.values().next().value ?? null;
  }
  return throwAmbiguousOwnerValue(diagnosticNode);
}

function symbolForExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Symbol | undefined {
  const direct = checker.getSymbolAtLocation(expression);
  if (direct) return direct;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const argument = unwrappedExpression(expression.argumentExpression);
    if (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) {
      return checker.getTypeAtLocation(expression.expression).getProperty(argument.text);
    }
  }
  return undefined;
}

interface SymbolWrite {
  expression: ts.Expression;
  node: ts.Node;
  position: number;
}

interface CommonJsValueProvenance {
  file: string;
  path: string[];
}

const assignmentWriteCache = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.SourceFile, Map<ts.Symbol, SymbolWrite[]>>
>();
const ownerCommonJsSourceCache = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.SourceFile, boolean>
>();

function executionScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return current ?? node.getSourceFile();
}

function sameResolvedSymbol(
  checker: ts.TypeChecker,
  left: ts.Symbol | undefined,
  right: ts.Symbol,
): boolean {
  return resolveAliasedSymbol(checker, left) === right;
}

function initialWriteForDeclaration(declaration: ts.Declaration): SymbolWrite | null {
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return {
      expression: declaration.initializer,
      node: declaration,
      position: declaration.getStart(),
    };
  }
  if (ts.isPropertyAssignment(declaration)) {
    return {
      expression: declaration.initializer,
      node: declaration,
      position: declaration.getStart(),
    };
  }
  if (ts.isShorthandPropertyAssignment(declaration)) {
    return {
      expression: declaration.name,
      node: declaration,
      position: declaration.getStart(),
    };
  }
  if (ts.isPropertyDeclaration(declaration) && declaration.initializer) {
    return {
      expression: declaration.initializer,
      node: declaration,
      position: declaration.getStart(),
    };
  }
  return null;
}

function assignmentWritesForSource(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): Map<ts.Symbol, SymbolWrite[]> {
  let checkerCache = assignmentWriteCache.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap<ts.SourceFile, Map<ts.Symbol, SymbolWrite[]>>();
    assignmentWriteCache.set(checker, checkerCache);
  }
  const cached = checkerCache.get(sourceFile);
  if (cached) return cached;

  const writes = new Map<ts.Symbol, SymbolWrite[]>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isExpression(node.left)
    ) {
      const symbol = resolveAliasedSymbol(checker, symbolForExpression(checker, node.left));
      if (symbol) {
        const entries = writes.get(symbol) ?? [];
        entries.push({ expression: node.right, node, position: node.getStart(sourceFile) });
        writes.set(symbol, entries);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  checkerCache.set(sourceFile, writes);
  return writes;
}

function writesForSymbolAt(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  atNode: ts.Node,
): SymbolWrite[] {
  const atPosition = atNode.getStart();
  const callScope = executionScope(atNode);
  const writes = (symbol.declarations ?? [])
    .map(initialWriteForDeclaration)
    .filter((write): write is SymbolWrite => (
      write !== null
      && write.node.getSourceFile() === atNode.getSourceFile()
      && write.position < atPosition
    ));
  const sourceFile = atNode.getSourceFile();
  for (const write of assignmentWritesForSource(checker, sourceFile).get(symbol) ?? []) {
    if (write.position >= atPosition) continue;
    const writeScope = executionScope(write.node);
    if (writeScope === callScope || ts.isSourceFile(writeScope)) writes.push(write);
  }
  return writes.sort((left, right) => left.position - right.position);
}

function literalAccessName(expression: ts.Expression): string | null {
  const target = unwrappedExpression(expression);
  return ts.isStringLiteralLike(target) || ts.isNumericLiteral(target) ? target.text : null;
}

function commonJsModuleFile(specifier: string, importer: string): string | null {
  const resolvedModule = ts.resolveModuleName(
    specifier,
    importer,
    readCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  if (!resolvedModule || resolvedModule.isExternalLibraryImport) return null;
  return relative(mainRoot, resolve(resolvedModule.resolvedFileName));
}

function sourceHasOwnerCommonJsRequire(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): boolean {
  let checkerCache = ownerCommonJsSourceCache.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap<ts.SourceFile, boolean>();
    ownerCommonJsSourceCache.set(checker, checkerCache);
  }
  const cached = checkerCache.get(sourceFile);
  if (cached !== undefined) return cached;
  if (!sourceFile.text.includes('require')) {
    checkerCache.set(sourceFile, false);
    return false;
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
      && isCommonJsRequire(checker, node.expression)
    ) {
      const file = commonJsModuleFile(node.arguments[0].text, sourceFile.fileName);
      found = file === 'rlm/context-manager.ts'
        || file === 'memory/unified-controller.ts'
        || file === 'instance/instance-context.ts';
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  checkerCache.set(sourceFile, found);
  return found;
}

function commonJsProvenanceForBindingElement(
  checker: ts.TypeChecker,
  declaration: ts.BindingElement,
  visited: Set<ts.Symbol>,
  atNode: ts.Node,
): CommonJsValueProvenance | null {
  const variable = containingVariableDeclaration(declaration);
  if (!variable?.initializer) return null;
  const base = commonJsProvenanceForExpression(
    checker,
    variable.initializer,
    visited,
    declaration.getStart() < atNode.getStart() ? declaration : atNode,
  );
  if (!base) return null;
  if (ts.isObjectBindingPattern(declaration.parent)) {
    const propertyName = declaration.propertyName ?? declaration.name;
    const name = ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName)
      ? propertyName.text
      : null;
    return name ? { ...base, path: [...base.path, name] } : null;
  }
  if (ts.isArrayBindingPattern(declaration.parent)) {
    const index = declaration.parent.elements.indexOf(declaration);
    return index >= 0 ? { ...base, path: [...base.path, String(index)] } : null;
  }
  return null;
}

function commonJsAccessPath(expression: ts.Expression): {
  base: ts.Expression;
  path: string[];
} | null {
  const path: string[] = [];
  let current = unwrappedExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      path.unshift(current.name.text);
    } else {
      if (!current.argumentExpression) return null;
      const name = literalAccessName(current.argumentExpression);
      if (name === null) return null;
      path.unshift(name);
    }
    current = unwrappedExpression(current.expression);
  }
  return path.length > 0 ? { base: current, path } : null;
}

function commonJsProvenanceForPath(
  checker: ts.TypeChecker,
  source: ts.Expression,
  path: string[],
  visited: Set<ts.Symbol>,
  atNode: ts.Node,
): CommonJsValueProvenance | null {
  const target = unwrappedExpression(source);
  const base = commonJsProvenanceForExpression(checker, target, new Set(visited), atNode);
  if (base) return { ...base, path: [...base.path, ...path] };
  if (path.length === 0) return null;
  const [propertyName, ...remainingPath] = path;

  if (ts.isArrayLiteralExpression(target)) {
    const element = target.elements[Number(propertyName)];
    return element && ts.isExpression(element)
      ? commonJsProvenanceForPath(checker, element, remainingPath, visited, atNode)
      : null;
  }
  if (ts.isObjectLiteralExpression(target)) {
    for (const property of target.properties) {
      if (ts.isSpreadAssignment(property)) continue;
      const name = property.name && (
        ts.isIdentifier(property.name)
        || ts.isStringLiteralLike(property.name)
        || ts.isNumericLiteral(property.name)
      ) ? property.name.text : null;
      if (name !== propertyName) continue;
      if (ts.isPropertyAssignment(property)) {
        return commonJsProvenanceForPath(
          checker,
          property.initializer,
          remainingPath,
          visited,
          atNode,
        );
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const valueSymbol = resolveAliasedSymbol(
          checker,
          checker.getShorthandAssignmentValueSymbol(property),
        );
        if (!valueSymbol || visited.has(valueSymbol)) return null;
        const nextVisited = new Set(visited).add(valueSymbol);
        const latestWrite = writesForSymbolAt(checker, valueSymbol, atNode).at(-1);
        return latestWrite
          ? commonJsProvenanceForPath(
            checker,
            latestWrite.expression,
            remainingPath,
            nextVisited,
            latestWrite.node,
          )
          : null;
      }
    }
    return null;
  }

  const symbol = resolveAliasedSymbol(checker, symbolForExpression(checker, target));
  if (!symbol || visited.has(symbol)) return null;
  const nextVisited = new Set(visited).add(symbol);
  const latestWrite = writesForSymbolAt(checker, symbol, atNode).at(-1);
  return latestWrite
    ? commonJsProvenanceForPath(
      checker,
      latestWrite.expression,
      path,
      nextVisited,
      latestWrite.node,
    )
    : null;
}

function commonJsProvenanceForExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  visited: Set<ts.Symbol>,
  atNode: ts.Node,
): CommonJsValueProvenance | null {
  const target = unwrappedExpression(expression);
  if (
    ts.isCallExpression(target)
    && ts.isIdentifier(target.expression)
    && target.expression.text === 'require'
    && target.arguments.length === 1
    && ts.isStringLiteralLike(target.arguments[0])
    && isCommonJsRequire(checker, target.expression)
  ) {
    const file = commonJsModuleFile(target.arguments[0].text, target.getSourceFile().fileName);
    return file ? { file, path: [] } : null;
  }
  const access = commonJsAccessPath(target);
  if (access) {
    return commonJsProvenanceForPath(checker, access.base, access.path, visited, atNode);
  }

  const symbol = resolveAliasedSymbol(checker, symbolForExpression(checker, target));
  if (!symbol || visited.has(symbol)) return null;
  visited.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isBindingElement(declaration)) continue;
    const provenance = commonJsProvenanceForBindingElement(
      checker,
      declaration,
      new Set(visited),
      atNode,
    );
    if (provenance) return provenance;
  }
  const latestWrite = writesForSymbolAt(checker, symbol, atNode).at(-1);
  return latestWrite
    ? commonJsProvenanceForExpression(
      checker,
      latestWrite.expression,
      visited,
      latestWrite.node,
    )
    : null;
}

function ownerCalleeForCommonJsExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  invocation: 'call' | 'new',
  visited: Set<ts.Symbol>,
  atNode: ts.Node,
): string | null {
  if (!sourceHasOwnerCommonJsRequire(checker, expression.getSourceFile())) return null;
  const provenance = commonJsProvenanceForExpression(
    checker,
    expression,
    visited,
    atNode,
  );
  if (!provenance) return null;
  return ownerCalleeForCommonJsProvenance(provenance, invocation);
}

function ownerCalleeForCommonJsProvenance(
  provenance: CommonJsValueProvenance,
  invocation: 'call' | 'new',
): string | null {
  const path = provenance.path.join('.');
  if (
    invocation === 'new'
    && provenance.file === 'instance/instance-context.ts'
    && path === 'InstanceContextManager'
  ) return 'new InstanceContextManager';
  if (invocation !== 'call') return null;
  if (provenance.file === 'rlm/context-manager.ts') {
    if (path === 'RLMContextManager.getInstance') return 'RLMContextManager.getInstance';
    if (path === 'getRLMContextManager') return 'getRLMContextManager';
  }
  if (provenance.file === 'memory/unified-controller.ts') {
    if (path === 'UnifiedMemoryController.getInstance') {
      return 'UnifiedMemoryController.getInstance';
    }
    if (path === 'getUnifiedMemory') return 'getUnifiedMemory';
  }
  return null;
}

function uncertainControlFlowAncestor(node: ts.Node, atNode: ts.Node): ts.Node | null {
  const scope = executionScope(node);
  let current: ts.Node | undefined = node.parent;
  while (current && current !== scope) {
    if (
      ts.isIfStatement(current)
      || ts.isConditionalExpression(current)
      || ts.isSwitchStatement(current)
      || ts.isForStatement(current)
      || ts.isForInStatement(current)
      || ts.isForOfStatement(current)
      || ts.isWhileStatement(current)
      || ts.isDoStatement(current)
      || ts.isTryStatement(current)
    ) {
      const containsCall = current.getStart() <= atNode.getStart()
        && current.getEnd() >= atNode.getEnd();
      if (!containsCall) return current;
    }
    current = current.parent;
  }
  return null;
}

function undefinedStateForExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): 'defined' | 'possible' | 'undefined' {
  const type = checker.getTypeAtLocation(unwrappedExpression(expression));
  if ((type.flags & ts.TypeFlags.Undefined) !== 0) return 'undefined';
  if (type.isUnion() && type.types.some(
    (member) => (member.flags & ts.TypeFlags.Undefined) !== 0,
  )) return 'possible';
  return 'defined';
}

function ownerCalleeForBindingValue(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  fallback: ts.Expression | undefined,
  invocation: 'call' | 'new',
  visited: Set<ts.Symbol>,
  atNode: ts.Node,
  diagnosticNode: ts.Node,
): string | null {
  const target = unwrappedExpression(expression);
  if (ts.isConditionalExpression(target)) {
    return mergeOwnerBranchValues(
      [target.whenTrue, target.whenFalse].map((branch) => ownerCalleeForBindingValue(
        checker,
        branch,
        fallback,
        invocation,
        new Set(visited),
        atNode,
        diagnosticNode,
      )),
      diagnosticNode,
    );
  }
  if (
    ts.isBinaryExpression(target)
    && (
      target.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || target.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    )
  ) {
    return mergeOwnerBranchValues(
      [target.left, target.right].map((branch) => ownerCalleeForBindingValue(
        checker,
        branch,
        fallback,
        invocation,
        new Set(visited),
        atNode,
        diagnosticNode,
      )),
      diagnosticNode,
    );
  }

  const undefinedState = undefinedStateForExpression(checker, target);
  if (undefinedState === 'undefined') {
    return fallback
      ? ownerCalleeForExpression(
        checker,
        fallback,
        invocation,
        visited,
        atNode,
        diagnosticNode,
      )
      : null;
  }
  if (undefinedState === 'possible') {
    const symbol = resolveAliasedSymbol(checker, symbolForExpression(checker, target));
    if (symbol && !visited.has(symbol)) {
      const nextVisited = new Set(visited).add(symbol);
      const writes = writesForSymbolAt(checker, symbol, atNode);
      const latestWrite = writes.at(-1);
      if (latestWrite) {
        const uncertainAncestor = uncertainControlFlowAncestor(latestWrite.node, atNode);
        if (uncertainAncestor && ts.isIfStatement(uncertainAncestor)) {
          const priorWrite = writes
            .filter((write) => write.position < uncertainAncestor.getStart())
            .at(-1);
          const thenWrite = writes
            .filter((write) => writeWithinStatement(write, uncertainAncestor.thenStatement))
            .at(-1);
          const elseWrite = uncertainAncestor.elseStatement
            ? writes
              .filter((write) => writeWithinStatement(write, uncertainAncestor.elseStatement!))
              .at(-1)
            : undefined;
          return mergeOwnerBranchValues(
            [thenWrite ?? priorWrite, elseWrite ?? priorWrite].map((write) => write
              ? ownerCalleeForBindingValue(
                checker,
                write.expression,
                fallback,
                invocation,
                new Set(nextVisited),
                write.node,
                diagnosticNode,
              )
              : fallback
                ? ownerCalleeForExpression(
                  checker,
                  fallback,
                  invocation,
                  new Set(nextVisited),
                  atNode,
                  diagnosticNode,
                )
                : null),
            diagnosticNode,
          );
        }
        return ownerCalleeForBindingValue(
          checker,
          latestWrite.expression,
          fallback,
          invocation,
          nextVisited,
          latestWrite.node,
          diagnosticNode,
        );
      }
    }
    return mergeOwnerBranchValues(
      [
        ownerCalleeForExpression(
          checker,
          target,
          invocation,
          new Set(visited),
          atNode,
          diagnosticNode,
        ),
        fallback
          ? ownerCalleeForExpression(
            checker,
            fallback,
            invocation,
            new Set(visited),
            atNode,
            diagnosticNode,
          )
          : null,
      ],
      diagnosticNode,
    );
  }
  return ownerCalleeForExpression(
    checker,
    target,
    invocation,
    visited,
    atNode,
    diagnosticNode,
  );
}

function ownerCalleeForBindingElement(
  checker: ts.TypeChecker,
  declaration: ts.BindingElement,
  invocation: 'call' | 'new',
  visited: Set<ts.Symbol>,
  atNode: ts.Node,
  diagnosticNode: ts.Node,
): string | null {
  const variable = containingVariableDeclaration(declaration);
  if (!variable?.initializer) return null;
  const bindingAtNode = declaration.getStart() < atNode.getStart() ? declaration : atNode;
  let propertyName: string | null = null;
  if (ts.isObjectBindingPattern(declaration.parent)) {
    const property = declaration.propertyName ?? declaration.name;
    propertyName = ts.isIdentifier(property) || ts.isStringLiteralLike(property)
      ? property.text
      : null;
  }
  if (ts.isArrayBindingPattern(declaration.parent)) {
    const index = declaration.parent.elements.indexOf(declaration);
    propertyName = index >= 0 ? String(index) : null;
  }
  if (propertyName === null) return null;

  const definiteValue = definitePropertyValueAt(
    checker,
    variable.initializer,
    propertyName,
    bindingAtNode,
    new Set(visited),
  );
  if (definiteValue.kind === 'present') {
    return ownerCalleeForBindingValue(
      checker,
      definiteValue.expression,
      declaration.initializer,
      invocation,
      visited,
      bindingAtNode,
      diagnosticNode,
    );
  }
  if (definiteValue.kind === 'absent') {
    return declaration.initializer
      ? ownerCalleeForExpression(
        checker,
        declaration.initializer,
        invocation,
        visited,
        bindingAtNode,
        diagnosticNode,
      )
      : null;
  }
  return ownerCalleeForPropertyValue(
    checker,
    variable.initializer,
    propertyName,
    invocation,
    visited,
    bindingAtNode,
    diagnosticNode,
  );
}

type DefinitePropertyValue =
  | { kind: 'present'; expression: ts.Expression }
  | { kind: 'absent' }
  | { kind: 'unknown' };

function definitePropertyValueAt(
  checker: ts.TypeChecker,
  source: ts.Expression,
  propertyName: string,
  atNode: ts.Node,
  visited: Set<ts.Symbol>,
): DefinitePropertyValue {
  const target = unwrappedExpression(source);
  const propertySymbol = resolveAliasedSymbol(
    checker,
    checker.getTypeAtLocation(target).getProperty(propertyName),
  );
  const latestPropertyWrite = propertySymbol
    ? writesForSymbolAt(checker, propertySymbol, atNode).at(-1)
    : undefined;
  if (latestPropertyWrite) {
    return { kind: 'present', expression: latestPropertyWrite.expression };
  }
  if (ts.isArrayLiteralExpression(target)) {
    const element = target.elements[Number(propertyName)];
    if (!element || ts.isOmittedExpression(element)) return { kind: 'absent' };
    return ts.isSpreadElement(element)
      ? { kind: 'unknown' }
      : { kind: 'present', expression: element };
  }
  if (ts.isObjectLiteralExpression(target)) {
    let hasSpread = false;
    for (const property of [...target.properties].reverse()) {
      if (ts.isSpreadAssignment(property)) {
        hasSpread = true;
        continue;
      }
      const name = property.name && (
        ts.isIdentifier(property.name)
        || ts.isStringLiteralLike(property.name)
        || ts.isNumericLiteral(property.name)
      ) ? property.name.text : null;
      if (name !== propertyName) continue;
      if (ts.isPropertyAssignment(property)) {
        return { kind: 'present', expression: property.initializer };
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return { kind: 'present', expression: property.name };
      }
      return { kind: 'unknown' };
    }
    return hasSpread ? { kind: 'unknown' } : { kind: 'absent' };
  }

  const symbol = resolveAliasedSymbol(checker, symbolForExpression(checker, target));
  if (!symbol || visited.has(symbol)) return { kind: 'unknown' };
  const latestWrite = writesForSymbolAt(checker, symbol, atNode).at(-1);
  if (!latestWrite) return { kind: 'unknown' };
  visited.add(symbol);
  return definitePropertyValueAt(
    checker,
    latestWrite.expression,
    propertyName,
    latestWrite.node,
    visited,
  );
}

function ownerCalleeForPropertyValue(
  checker: ts.TypeChecker,
  source: ts.Expression,
  propertyName: string,
  invocation: 'call' | 'new',
  visited: Set<ts.Symbol>,
  atNode: ts.Node,
  diagnosticNode: ts.Node,
): string | null {
  const target = unwrappedExpression(source);
  const propertySymbol = checker.getTypeAtLocation(target).getProperty(propertyName);
  const resolvedPropertySymbol = resolveAliasedSymbol(checker, propertySymbol);
  if (
    resolvedPropertySymbol
    && writesForSymbolAt(checker, resolvedPropertySymbol, atNode).length > 0
  ) {
    return ownerCalleeForSymbol(
      checker,
      resolvedPropertySymbol,
      invocation,
      visited,
      atNode,
      diagnosticNode,
    );
  }
  if (ts.isArrayLiteralExpression(target)) {
    const element = target.elements[Number(propertyName)];
    if (element && ts.isExpression(element)) {
      return ownerCalleeForExpression(
        checker,
        element,
        invocation,
        visited,
        atNode,
        diagnosticNode,
      );
    }
    return null;
  }
  if (ts.isObjectLiteralExpression(target)) {
    for (const property of target.properties) {
      if (ts.isSpreadAssignment(property)) continue;
      const name = property.name && (
        ts.isIdentifier(property.name)
        || ts.isStringLiteralLike(property.name)
        || ts.isNumericLiteral(property.name)
      ) ? property.name.text : null;
      if (name !== propertyName) continue;
      if (ts.isPropertyAssignment(property)) {
        return ownerCalleeForExpression(
          checker,
          property.initializer,
          invocation,
          visited,
          atNode,
          diagnosticNode,
        );
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return ownerCalleeForExpression(
          checker,
          property.name,
          invocation,
          visited,
          atNode,
          diagnosticNode,
        );
      }
    }
  }

  const commonJs = commonJsProvenanceForExpression(checker, target, new Set(visited), atNode);
  if (commonJs) {
    return ownerCalleeForCommonJsProvenance(
      { ...commonJs, path: [...commonJs.path, propertyName] },
      invocation,
    );
  }

  const sourceSymbol = resolveAliasedSymbol(checker, symbolForExpression(checker, target));
  if (sourceSymbol && !visited.has(sourceSymbol)) {
    const nextVisited = new Set(visited).add(sourceSymbol);
    const latestWrite = writesForSymbolAt(checker, sourceSymbol, atNode).at(-1);
    if (latestWrite) {
      const fromWrite = ownerCalleeForPropertyValue(
        checker,
        latestWrite.expression,
        propertyName,
        invocation,
        nextVisited,
        latestWrite.node,
        diagnosticNode,
      );
      if (fromWrite) return fromWrite;
    }
  }

  return ownerCalleeForSymbol(
    checker,
    propertySymbol,
    invocation,
    visited,
    atNode,
    diagnosticNode,
  );
}

function writeWithinStatement(write: SymbolWrite, statement: ts.Statement): boolean {
  return write.node.getStart() >= statement.getStart()
    && write.node.getEnd() <= statement.getEnd();
}

function ownerCalleeForIfAssignment(
  checker: ts.TypeChecker,
  ifStatement: ts.IfStatement,
  writes: SymbolWrite[],
  invocation: 'call' | 'new',
  visited: Set<ts.Symbol>,
  diagnosticNode: ts.Node,
): string | null {
  const priorWrite = writes
    .filter((write) => write.position < ifStatement.getStart())
    .at(-1);
  const thenWrite = writes
    .filter((write) => writeWithinStatement(write, ifStatement.thenStatement))
    .at(-1);
  const elseWrite = ifStatement.elseStatement
    ? writes
      .filter((write) => writeWithinStatement(write, ifStatement.elseStatement!))
      .at(-1)
    : undefined;
  const branchWrites = [thenWrite ?? priorWrite, elseWrite ?? priorWrite];
  return mergeOwnerBranchValues(
    branchWrites.map((write) => write
      ? ownerCalleeForExpression(
        checker,
        write.expression,
        invocation,
        new Set(visited),
        write.node,
        diagnosticNode,
      )
      : null),
    diagnosticNode,
  );
}

interface AliasCycleResolution {
  foundCycle: boolean;
  callee: string | null;
}

function localAliasSymbolForExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  invocation: 'call' | 'new',
  atNode: ts.Node,
): ts.Symbol | null {
  const target = unwrappedExpression(expression);
  if (
    ts.isConditionalExpression(target)
    || ts.isBinaryExpression(target)
    || ts.isArrowFunction(target)
    || ts.isFunctionExpression(target)
    || ts.isClassExpression(target)
  ) return null;
  const symbol = resolveAliasedSymbol(checker, symbolForExpression(checker, target));
  if (
    !symbol
    || directOwnerCalleeForSymbol(checker, symbol, invocation)
    || writesForSymbolAt(checker, symbol, atNode).length === 0
  ) return null;
  return symbol;
}

function graphContainsCycle(
  nodes: Set<ts.Symbol>,
  edges: Map<ts.Symbol, Set<ts.Symbol>>,
): boolean {
  const complete = new Set<ts.Symbol>();
  const active = new Set<ts.Symbol>();
  const visit = (symbol: ts.Symbol): boolean => {
    if (active.has(symbol)) return true;
    if (complete.has(symbol)) return false;
    active.add(symbol);
    for (const target of edges.get(symbol) ?? []) {
      if (visit(target)) return true;
    }
    active.delete(symbol);
    complete.add(symbol);
    return false;
  };
  return [...nodes].some(visit);
}

function ownerCalleeForAliasCycle(
  checker: ts.TypeChecker,
  root: ts.Symbol,
  invocation: 'call' | 'new',
  visited: Set<ts.Symbol>,
  atNode: ts.Node,
  diagnosticNode: ts.Node,
): AliasCycleResolution {
  const nodes = new Set<ts.Symbol>([root]);
  const edges = new Map<ts.Symbol, Set<ts.Symbol>>();
  const pending = [root];
  while (pending.length > 0) {
    const symbol = pending.pop()!;
    for (const write of writesForSymbolAt(checker, symbol, atNode)) {
      const target = localAliasSymbolForExpression(
        checker,
        write.expression,
        invocation,
        write.node,
      );
      if (!target) continue;
      const targets = edges.get(symbol) ?? new Set<ts.Symbol>();
      targets.add(target);
      edges.set(symbol, targets);
      if (!nodes.has(target)) {
        nodes.add(target);
        pending.push(target);
      }
    }
  }
  if (!graphContainsCycle(nodes, edges)) return { foundCycle: false, callee: null };

  const owners = new Set<string>();
  let hasUnrelatedSeed = false;
  const cycleVisited = new Set([...visited, ...nodes]);
  for (const symbol of nodes) {
    for (const write of writesForSymbolAt(checker, symbol, atNode)) {
      const alias = localAliasSymbolForExpression(
        checker,
        write.expression,
        invocation,
        write.node,
      );
      if (alias && nodes.has(alias)) continue;
      const owner = ownerCalleeForExpression(
        checker,
        write.expression,
        invocation,
        new Set(cycleVisited),
        write.node,
        diagnosticNode,
      );
      if (owner) owners.add(owner);
      else hasUnrelatedSeed = true;
    }
  }
  if (owners.size === 0) return { foundCycle: true, callee: null };
  if (owners.size === 1 && !hasUnrelatedSeed) {
    return { foundCycle: true, callee: owners.values().next().value ?? null };
  }
  return throwAmbiguousOwnerValue(diagnosticNode);
}

function ownerCalleeForSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  invocation: 'call' | 'new',
  visited: Set<ts.Symbol>,
  atNode: ts.Node,
  diagnosticNode: ts.Node = atNode,
): string | null {
  const resolvedSymbol = resolveAliasedSymbol(checker, symbol);
  if (!resolvedSymbol || visited.has(resolvedSymbol)) return null;

  const direct = directOwnerCalleeForSymbol(checker, resolvedSymbol, invocation);
  if (direct) return direct;

  const cycle = ownerCalleeForAliasCycle(
    checker,
    resolvedSymbol,
    invocation,
    visited,
    atNode,
    diagnosticNode,
  );
  if (cycle.foundCycle) return cycle.callee;
  visited.add(resolvedSymbol);

  for (const declaration of resolvedSymbol.declarations ?? []) {
    if (!ts.isBindingElement(declaration)) continue;
    const callee = ownerCalleeForBindingElement(
      checker,
      declaration,
      invocation,
      visited,
      atNode,
      diagnosticNode,
    );
    if (callee) return callee;
  }

  const writes = writesForSymbolAt(checker, resolvedSymbol, atNode);
  const latestWrite = writes.at(-1);
  if (latestWrite) {
    const uncertainAncestor = uncertainControlFlowAncestor(latestWrite.node, atNode);
    if (uncertainAncestor && ts.isIfStatement(uncertainAncestor)) {
      return ownerCalleeForIfAssignment(
        checker,
        uncertainAncestor,
        writes,
        invocation,
        visited,
        diagnosticNode,
      );
    }
    if (uncertainAncestor) {
      const possibleOwner = writes.some((write) => ownerCalleeForExpression(
        checker,
        write.expression,
        invocation,
        new Set(visited),
        write.node,
        diagnosticNode,
      ) !== null);
      if (possibleOwner) {
        throwAmbiguousOwnerValue(diagnosticNode);
      }
    }
    return ownerCalleeForExpression(
      checker,
      latestWrite.expression,
      invocation,
      visited,
      latestWrite.node,
      diagnosticNode,
    );
  }
  return null;
}

function ownerCallsInClosure(
  program: ts.Program,
  role: string,
  closure: Set<string>,
): OwnerCallManifestEntry[] {
  const checker = program.getTypeChecker();
  const counts = new Map<string, OwnerCallManifestEntry>();
  for (const fileName of [...closure].sort()) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) continue;
    const visit = (node: ts.Node): void => {
      const invocation = ts.isNewExpression(node) ? 'new' : ts.isCallExpression(node) ? 'call' : null;
      const expression = ts.isNewExpression(node) || ts.isCallExpression(node)
        ? node.expression
        : null;
      if (invocation && expression) {
        const callee = ownerCalleeForExpression(
          checker,
          expression,
          invocation,
          new Set<ts.Symbol>(),
          node,
        );
        if (callee) {
          const file = relative(mainRoot, fileName);
          const key = `${file}\0${callee}`;
          const existing = counts.get(key);
          counts.set(key, {
            role,
            file,
            callee,
            count: (existing?.count ?? 0) + 1,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...counts.values()].sort((left, right) => (
    `${left.role}:${left.file}:${left.callee}`.localeCompare(
      `${right.role}:${right.file}:${right.callee}`,
    )
  ));
}

function analyzeProductionOwnership(): {
  calls: OwnerCallManifestEntry[];
  closures: Record<keyof typeof processRoots, string[]>;
} {
  const program = createOwnershipProgram();
  const calls: OwnerCallManifestEntry[] = [];
  const closures = {} as Record<keyof typeof processRoots, string[]>;
  for (const [role, root] of Object.entries(processRoots) as [keyof typeof processRoots, string][]) {
    const closure = runtimeClosure(program, root);
    closures[role] = [...closure].map((file) => relative(mainRoot, file)).sort();
    calls.push(...ownerCallsInClosure(program, role, closure));
  }
  return { calls, closures };
}

const semanticFixtureSources = {
  'fixture-alias.ts': [
    "import { getRLMContextManager as getManager, RLMContextManager as Manager } from '../rlm/context-manager';",
    "import * as memory from '../memory/unified-controller';",
    "import { UnifiedMemoryController as Controller } from '../memory/unified-controller';",
    "import { InstanceContextManager as LocalContext } from './instance-context';",
    'getManager();',
    'Manager.getInstance();',
    'memory.getUnifiedMemory();',
    'Controller.getInstance();',
    'new LocalContext();',
  ].join('\n'),
  'fixture-local-alias.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const rlmFactory = RLMContextManager.getInstance;',
    'const rlmFactoryChain = rlmFactory;',
    'rlmFactoryChain();',
    'const managerFactory = getRLMContextManager;',
    'const managerFactoryChain = managerFactory;',
    'managerFactoryChain();',
    'const controllerFactory = UnifiedMemoryController.getInstance;',
    'const controllerFactoryChain = controllerFactory;',
    'controllerFactoryChain();',
    'const memoryFactory = getUnifiedMemory;',
    'const memoryFactoryChain = memoryFactory;',
    'memoryFactoryChain();',
    'const ContextCtor = InstanceContextManager;',
    'const ContextCtorChain = ContextCtor;',
    'new ContextCtorChain();',
  ].join('\n'),
  'fixture-property-alias.ts': [
    "import * as rlm from '../rlm/context-manager';",
    "import * as memory from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const { RLMContextManager: RlmClass } = rlm;',
    'const { getInstance: rlmFactory } = RlmClass;',
    'rlmFactory();',
    'const { getRLMContextManager: managerFactory } = rlm;',
    'managerFactory();',
    'const owners = {',
    '  controllerFactory: memory.UnifiedMemoryController.getInstance,',
    '  memoryFactory: memory.getUnifiedMemory,',
    '  ContextCtor: InstanceContextManager,',
    '} as const;',
    'const { controllerFactory } = owners;',
    'const controllerFactoryChain = controllerFactory;',
    'controllerFactoryChain();',
    'const memoryFactory = owners.memoryFactory;',
    'memoryFactory();',
    'const { ContextCtor } = owners;',
    'new ContextCtor();',
    'const local = {',
    '  RLMContextManager: { getInstance: () => ({}) },',
    '  getRLMContextManager: () => ({}),',
    '  UnifiedMemoryController: { getInstance: () => ({}) },',
    '  getUnifiedMemory: () => ({}),',
    '  ContextCtor: class LocalContext {},',
    '} as const;',
    'const shadowRlmFactory = local.RLMContextManager.getInstance;',
    'const { getRLMContextManager: shadowManagerFactory } = local;',
    'const shadowControllerFactory = local.UnifiedMemoryController.getInstance;',
    'const { getUnifiedMemory: shadowMemoryFactory } = local;',
    'const shadowContextCtor = local.ContextCtor;',
    'shadowRlmFactory();',
    'shadowManagerFactory();',
    'shadowControllerFactory();',
    'shadowMemoryFactory();',
    'new shadowContextCtor();',
  ].join('\n'),
  'fixture-computed-property-alias.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const owners = {',
    "  ['rlmFactory']: RLMContextManager.getInstance,",
    "  ['managerFactory']: getRLMContextManager,",
    "  ['controllerFactory']: UnifiedMemoryController.getInstance,",
    "  ['memoryFactory']: getUnifiedMemory,",
    "  ['ContextCtor']: InstanceContextManager,",
    '} as const;',
    "owners['rlmFactory']();",
    "owners['managerFactory']();",
    "owners['controllerFactory']();",
    "owners['memoryFactory']();",
    "new owners['ContextCtor']();",
  ].join('\n'),
  'fixture-readonly-property-alias.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'class OwnerAliases {',
    '  static readonly rlmFactory = RLMContextManager.getInstance;',
    '  static readonly managerFactory = getRLMContextManager;',
    '  static readonly controllerFactory = UnifiedMemoryController.getInstance;',
    '  static readonly memoryFactory = getUnifiedMemory;',
    '  static readonly ContextCtor = InstanceContextManager;',
    '}',
    'OwnerAliases.rlmFactory();',
    'OwnerAliases.managerFactory();',
    'OwnerAliases.controllerFactory();',
    'OwnerAliases.memoryFactory();',
    'new OwnerAliases.ContextCtor();',
  ].join('\n'),
  'fixture-let-write-alias.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'let rlmFactory: typeof RLMContextManager.getInstance;',
    'let managerFactory: typeof getRLMContextManager;',
    'let controllerFactory: typeof UnifiedMemoryController.getInstance;',
    'let memoryFactory: typeof getUnifiedMemory;',
    'let ContextCtor: typeof InstanceContextManager;',
    'rlmFactory = RLMContextManager.getInstance;',
    'managerFactory = getRLMContextManager;',
    'controllerFactory = UnifiedMemoryController.getInstance;',
    'memoryFactory = getUnifiedMemory;',
    'ContextCtor = InstanceContextManager;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-mutable-overwrite.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const unrelatedRlm = (() => { throw new Error(); }) as typeof RLMContextManager.getInstance;',
    'const unrelatedManager = (() => { throw new Error(); }) as typeof getRLMContextManager;',
    'const unrelatedController = (() => { throw new Error(); }) as typeof UnifiedMemoryController.getInstance;',
    'const unrelatedMemory = (() => { throw new Error(); }) as typeof getUnifiedMemory;',
    'const UnrelatedContext = class {} as unknown as typeof InstanceContextManager;',
    'const owners = {',
    '  rlmFactory: RLMContextManager.getInstance,',
    '  managerFactory: getRLMContextManager,',
    '  controllerFactory: UnifiedMemoryController.getInstance,',
    '  memoryFactory: getUnifiedMemory,',
    '  ContextCtor: InstanceContextManager,',
    '};',
    'owners.rlmFactory = unrelatedRlm;',
    'owners.managerFactory = unrelatedManager;',
    'owners.controllerFactory = unrelatedController;',
    'owners.memoryFactory = unrelatedMemory;',
    'owners.ContextCtor = UnrelatedContext;',
    'const { rlmFactory, managerFactory, controllerFactory, memoryFactory, ContextCtor } = owners;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-shadow-require.ts': [
    'export function run(): string {',
    '  const require = (value: string) => value;',
    "  return require('../rlm/context-manager');",
    '}',
  ].join('\n'),
  'fixture-require-direct.ts': [
    "require('../rlm/context-manager').RLMContextManager.getInstance();",
    "require('../rlm/context-manager').getRLMContextManager();",
    "require('../memory/unified-controller').UnifiedMemoryController.getInstance();",
    "require('../memory/unified-controller').getUnifiedMemory();",
    "new (require('./instance-context').InstanceContextManager)();",
  ].join('\n'),
  'fixture-require-destructured.ts': [
    "const { RLMContextManager, getRLMContextManager: getManager } = require('../rlm/context-manager');",
    "const { UnifiedMemoryController, getUnifiedMemory: getMemory } = require('../memory/unified-controller');",
    "const { InstanceContextManager: ContextCtor } = require('./instance-context');",
    'const rlmFactory = RLMContextManager.getInstance;',
    'const rlmFactoryAlias = rlmFactory;',
    'rlmFactoryAlias();',
    'getManager();',
    'const controllerFactory = UnifiedMemoryController.getInstance;',
    'controllerFactory();',
    'getMemory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-require-namespace.ts': [
    "const rlmNamespace = require('../rlm/context-manager');",
    'const rlmAlias = rlmNamespace;',
    "const memoryNamespace = require('../memory/unified-controller');",
    'const memoryAlias = memoryNamespace;',
    "const contextNamespace = require('./instance-context');",
    'const contextAlias = contextNamespace;',
    'rlmAlias.RLMContextManager.getInstance();',
    'rlmAlias.getRLMContextManager();',
    'memoryAlias.UnifiedMemoryController.getInstance();',
    'memoryAlias.getUnifiedMemory();',
    'new contextAlias.InstanceContextManager();',
  ].join('\n'),
  'fixture-require-object-alias.ts': [
    'export {};',
    'const owners = {',
    "  rlm: require('../rlm/context-manager'),",
    "  memory: require('../memory/unified-controller'),",
    "  context: require('./instance-context'),",
    '};',
    'const alias = owners;',
    'alias.rlm.RLMContextManager.getInstance();',
    'alias.rlm.getRLMContextManager();',
    'alias.memory.UnifiedMemoryController.getInstance();',
    'alias.memory.getUnifiedMemory();',
    'new alias.context.InstanceContextManager();',
  ].join('\n'),
  'fixture-require-nested-shorthand.ts': [
    'export {};',
    "const rlm = require('../rlm/context-manager');",
    "const memory = require('../memory/unified-controller');",
    "const context = require('./instance-context');",
    'const owners = {',
    '  nested: { rlm },',
    '  memoryContainer: { nested: { memory } },',
    '  contextContainer: { context },',
    '};',
    'const alias = owners;',
    'const chain = alias;',
    'chain.nested.rlm.RLMContextManager.getInstance();',
    'chain.nested.rlm.getRLMContextManager();',
    'chain.memoryContainer.nested.memory.UnifiedMemoryController.getInstance();',
    'chain.memoryContainer.nested.memory.getUnifiedMemory();',
    'new chain.contextContainer.context.InstanceContextManager();',
  ].join('\n'),
  'fixture-readonly-tuple.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const owners = [',
    '  RLMContextManager.getInstance,',
    '  getRLMContextManager,',
    '  UnifiedMemoryController.getInstance,',
    '  getUnifiedMemory,',
    '  InstanceContextManager,',
    '] as const;',
    'const [rlmFactory, managerFactory, controllerFactory, memoryFactory, ContextCtor] = owners;',
    'const rlmAlias = rlmFactory;',
    'const managerAlias = managerFactory;',
    'const controllerAlias = controllerFactory;',
    'const memoryAlias = memoryFactory;',
    'const ContextAlias = ContextCtor;',
    'rlmAlias();',
    'managerAlias();',
    'controllerAlias();',
    'memoryAlias();',
    'new ContextAlias();',
  ].join('\n'),
  'fixture-readonly-tuple-index.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const owners = [',
    '  RLMContextManager.getInstance,',
    '  getRLMContextManager,',
    '  UnifiedMemoryController.getInstance,',
    '  getUnifiedMemory,',
    '  InstanceContextManager,',
    '] as const;',
    'owners[0]();',
    'owners[1]();',
    'owners[2]();',
    'owners[3]();',
    'new owners[4]();',
  ].join('\n'),
  'fixture-tuple-binding-defaults.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const source: [',
    '  rlm?: typeof RLMContextManager.getInstance,',
    '  manager?: typeof getRLMContextManager,',
    '  controller?: typeof UnifiedMemoryController.getInstance,',
    '  memory?: typeof getUnifiedMemory,',
    '  context?: typeof InstanceContextManager,',
    '] = [];',
    'const [',
    '  rlmFactory = RLMContextManager.getInstance,',
    '  managerFactory = getRLMContextManager,',
    '  controllerFactory = UnifiedMemoryController.getInstance,',
    '  memoryFactory = getUnifiedMemory,',
    '  ContextCtor = InstanceContextManager,',
    '] = source;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-object-binding-defaults.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const source: {',
    '  rlm?: typeof RLMContextManager.getInstance;',
    '  manager?: typeof getRLMContextManager;',
    '  controller?: typeof UnifiedMemoryController.getInstance;',
    '  memory?: typeof getUnifiedMemory;',
    '  context?: typeof InstanceContextManager;',
    '} = {};',
    'const {',
    '  rlm: rlmFactory = RLMContextManager.getInstance,',
    '  manager: managerFactory = getRLMContextManager,',
    '  controller: controllerFactory = UnifiedMemoryController.getInstance,',
    '  memory: memoryFactory = getUnifiedMemory,',
    '  context: ContextCtor = InstanceContextManager,',
    '} = source;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-binding-default-definite-owner.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const unrelatedRlm = (() => ({})) as typeof RLMContextManager.getInstance;',
    'const unrelatedManager = (() => ({})) as typeof getRLMContextManager;',
    'const unrelatedController = (() => ({})) as typeof UnifiedMemoryController.getInstance;',
    'const unrelatedMemory = (() => ({})) as typeof getUnifiedMemory;',
    'const UnrelatedContext = class {} as unknown as typeof InstanceContextManager;',
    'const [',
    '  rlmFactory = unrelatedRlm,',
    '  managerFactory = unrelatedManager,',
    '  controllerFactory = unrelatedController,',
    '  memoryFactory = unrelatedMemory,',
    '  ContextCtor = UnrelatedContext,',
    '] = [',
    '  RLMContextManager.getInstance,',
    '  getRLMContextManager,',
    '  UnifiedMemoryController.getInstance,',
    '  getUnifiedMemory,',
    '  InstanceContextManager,',
    '] as const;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-binding-default-definite-unrelated.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const unrelatedRlm = (() => ({})) as typeof RLMContextManager.getInstance;',
    'const unrelatedManager = (() => ({})) as typeof getRLMContextManager;',
    'const unrelatedController = (() => ({})) as typeof UnifiedMemoryController.getInstance;',
    'const unrelatedMemory = (() => ({})) as typeof getUnifiedMemory;',
    'const UnrelatedContext = class {} as unknown as typeof InstanceContextManager;',
    'const [',
    '  rlmFactory = RLMContextManager.getInstance,',
    '  managerFactory = getRLMContextManager,',
    '  controllerFactory = UnifiedMemoryController.getInstance,',
    '  memoryFactory = getUnifiedMemory,',
    '  ContextCtor = InstanceContextManager,',
    '] = [',
    '  unrelatedRlm,',
    '  unrelatedManager,',
    '  unrelatedController,',
    '  unrelatedMemory,',
    '  UnrelatedContext,',
    '] as const;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-tuple-binding-explicit-undefined.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const [',
    '  rlmFactory = RLMContextManager.getInstance,',
    '  managerFactory = getRLMContextManager,',
    '  controllerFactory = UnifiedMemoryController.getInstance,',
    '  memoryFactory = getUnifiedMemory,',
    '  ContextCtor = InstanceContextManager,',
    '] = [undefined, undefined, undefined, undefined, undefined] as const;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-object-binding-explicit-undefined.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const {',
    '  rlm: rlmFactory = RLMContextManager.getInstance,',
    '  manager: managerFactory = getRLMContextManager,',
    '  controller: controllerFactory = UnifiedMemoryController.getInstance,',
    '  memory: memoryFactory = getUnifiedMemory,',
    '  context: ContextCtor = InstanceContextManager,',
    '} = { rlm: undefined, manager: undefined, controller: undefined, memory: undefined, context: undefined };',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-binding-void-zero.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const [',
    '  rlmFactory = RLMContextManager.getInstance,',
    '  managerFactory = getRLMContextManager,',
    '  controllerFactory = UnifiedMemoryController.getInstance,',
    '  memoryFactory = getUnifiedMemory,',
    '  ContextCtor = InstanceContextManager,',
    '] = [void 0, void 0, void 0, void 0, void 0] as const;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-binding-defined-falsy.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const UnrelatedContext = class {} as unknown as typeof InstanceContextManager;',
    'const source = {',
    '  rlm: null as unknown as typeof RLMContextManager.getInstance,',
    '  manager: false as unknown as typeof getRLMContextManager,',
    '  controller: 0 as unknown as typeof UnifiedMemoryController.getInstance,',
    "  memory: '' as unknown as typeof getUnifiedMemory,",
    '  context: UnrelatedContext,',
    '};',
    'const {',
    '  rlm: rlmFactory = RLMContextManager.getInstance,',
    '  manager: managerFactory = getRLMContextManager,',
    '  controller: controllerFactory = UnifiedMemoryController.getInstance,',
    '  memory: memoryFactory = getUnifiedMemory,',
    '  context: ContextCtor = InstanceContextManager,',
    '} = source;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-binding-shadowed-undefined.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    'const undefined = RLMContextManager.getInstance;',
    'const [factory = getRLMContextManager] = [undefined] as const;',
    'factory();',
  ].join('\n'),
  'fixture-binding-possible-undefined-same-owner.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const condition = Date.now() > 0;',
    'const [',
    '  rlmFactory = RLMContextManager.getInstance,',
    '  managerFactory = getRLMContextManager,',
    '  controllerFactory = UnifiedMemoryController.getInstance,',
    '  memoryFactory = getUnifiedMemory,',
    '  ContextCtor = InstanceContextManager,',
    '] = [',
    '  condition ? undefined : RLMContextManager.getInstance,',
    '  condition ? undefined : getRLMContextManager,',
    '  condition ? undefined : UnifiedMemoryController.getInstance,',
    '  condition ? undefined : getUnifiedMemory,',
    '  condition ? undefined : InstanceContextManager,',
    '] as const;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-binding-possible-undefined-mixed.ts': [
    "import { getRLMContextManager } from '../rlm/context-manager';",
    'const condition = Date.now() > 0;',
    'const unrelated = (() => ({})) as typeof getRLMContextManager;',
    'const [factory = getRLMContextManager] = [condition ? undefined : unrelated] as const;',
    'factory();',
  ].join('\n'),
  'fixture-owner-alias-cycles.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'let rlmA = RLMContextManager.getInstance; let rlmB = rlmA; rlmA = rlmB;',
    'let managerA = getRLMContextManager; let managerB = managerA; let managerC = managerB; managerA = managerC; managerC = managerA;',
    'let controllerA = UnifiedMemoryController.getInstance; let controllerB = controllerA; controllerA = controllerB;',
    'let memoryA = getUnifiedMemory; let memoryB = memoryA; memoryA = memoryB;',
    'let ContextA = InstanceContextManager; let ContextB = ContextA; ContextA = ContextB;',
    'rlmA();',
    'managerA();',
    'controllerA();',
    'memoryA();',
    'new ContextA();',
  ].join('\n'),
  'fixture-mixed-alias-cycle.ts': [
    "import { getRLMContextManager } from '../rlm/context-manager';",
    'const unrelated = (() => ({})) as typeof getRLMContextManager;',
    'let a = getRLMContextManager; let b = unrelated; a = b; b = a;',
    'a();',
  ].join('\n'),
  'fixture-distinct-owner-alias-cycle.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    'let a = getRLMContextManager; let b = RLMContextManager.getInstance; a = b; b = a;',
    'a();',
  ].join('\n'),
  'fixture-unrelated-alias-cycle.ts': [
    "import { getRLMContextManager } from '../rlm/context-manager';",
    'const unrelatedA = (() => ({})) as typeof getRLMContextManager;',
    'const unrelatedB = (() => ({})) as typeof getRLMContextManager;',
    'let a = unrelatedA; let b = unrelatedB; a = b; b = a;',
    'a();',
  ].join('\n'),
  'fixture-conditional-ambiguous-rlm-class.ts': [
    "import { RLMContextManager } from '../rlm/context-manager';",
    'const unrelated = (() => ({})) as typeof RLMContextManager.getInstance;',
    'const factory = Date.now() > 0 ? RLMContextManager.getInstance : unrelated;',
    'factory();',
  ].join('\n'),
  'fixture-conditional-ambiguous-rlm-helper.ts': [
    "import { getRLMContextManager } from '../rlm/context-manager';",
    'const unrelated = (() => ({})) as typeof getRLMContextManager;',
    'const factory = Date.now() > 0 ? getRLMContextManager : unrelated;',
    'factory();',
  ].join('\n'),
  'fixture-conditional-ambiguous-memory-class.ts': [
    "import { UnifiedMemoryController } from '../memory/unified-controller';",
    'const unrelated = (() => ({})) as typeof UnifiedMemoryController.getInstance;',
    'const factory = Date.now() > 0 ? UnifiedMemoryController.getInstance : unrelated;',
    'factory();',
  ].join('\n'),
  'fixture-conditional-ambiguous-memory-helper.ts': [
    "import { getUnifiedMemory } from '../memory/unified-controller';",
    'const unrelated = (() => ({})) as typeof getUnifiedMemory;',
    'const factory = Date.now() > 0 ? getUnifiedMemory : unrelated;',
    'factory();',
  ].join('\n'),
  'fixture-conditional-ambiguous-context.ts': [
    "import { InstanceContextManager } from './instance-context';",
    'const UnrelatedContext = class {} as unknown as typeof InstanceContextManager;',
    'const ContextCtor = Date.now() > 0 ? InstanceContextManager : UnrelatedContext;',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-conditional-same-owner.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const condition = Date.now() > 0;',
    'const rlmFactory = condition ? RLMContextManager.getInstance : RLMContextManager.getInstance;',
    'const managerFactory = condition ? getRLMContextManager : getRLMContextManager;',
    'const controllerFactory = condition ? UnifiedMemoryController.getInstance : UnifiedMemoryController.getInstance;',
    'const memoryFactory = condition ? getUnifiedMemory : getUnifiedMemory;',
    'const ContextCtor = condition ? InstanceContextManager : InstanceContextManager;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-conditional-unrelated.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const condition = Date.now() > 0;',
    'const unrelatedRlmA = (() => ({})) as typeof RLMContextManager.getInstance;',
    'const unrelatedRlmB = (() => ({})) as typeof RLMContextManager.getInstance;',
    'const unrelatedManagerA = (() => ({})) as typeof getRLMContextManager;',
    'const unrelatedManagerB = (() => ({})) as typeof getRLMContextManager;',
    'const unrelatedControllerA = (() => ({})) as typeof UnifiedMemoryController.getInstance;',
    'const unrelatedControllerB = (() => ({})) as typeof UnifiedMemoryController.getInstance;',
    'const unrelatedMemoryA = (() => ({})) as typeof getUnifiedMemory;',
    'const unrelatedMemoryB = (() => ({})) as typeof getUnifiedMemory;',
    'const UnrelatedContextA = class {} as unknown as typeof InstanceContextManager;',
    'const UnrelatedContextB = class {} as unknown as typeof InstanceContextManager;',
    'const rlmFactory = condition ? unrelatedRlmA : unrelatedRlmB;',
    'const managerFactory = condition ? unrelatedManagerA : unrelatedManagerB;',
    'const controllerFactory = condition ? unrelatedControllerA : unrelatedControllerB;',
    'const memoryFactory = condition ? unrelatedMemoryA : unrelatedMemoryB;',
    'const ContextCtor = condition ? UnrelatedContextA : UnrelatedContextB;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-if-same-owner.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const condition = Date.now() > 0;',
    'const rlmAlias = RLMContextManager.getInstance;',
    'const managerAlias = getRLMContextManager;',
    'const controllerAlias = UnifiedMemoryController.getInstance;',
    'const memoryAlias = getUnifiedMemory;',
    'const ContextAlias = InstanceContextManager;',
    'let rlmFactory: typeof RLMContextManager.getInstance;',
    'let managerFactory: typeof getRLMContextManager;',
    'let controllerFactory: typeof UnifiedMemoryController.getInstance;',
    'let memoryFactory: typeof getUnifiedMemory;',
    'let ContextCtor: typeof InstanceContextManager;',
    'if (condition) rlmFactory = rlmAlias; else rlmFactory = RLMContextManager.getInstance;',
    'if (condition) managerFactory = getRLMContextManager; else managerFactory = managerAlias;',
    'if (condition) controllerFactory = controllerAlias; else controllerFactory = UnifiedMemoryController.getInstance;',
    'if (condition) memoryFactory = getUnifiedMemory; else memoryFactory = memoryAlias;',
    'if (condition) ContextCtor = ContextAlias; else ContextCtor = InstanceContextManager;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-if-mixed-rlm-class.ts': [
    "import { RLMContextManager } from '../rlm/context-manager';",
    'const unrelated = (() => ({})) as typeof RLMContextManager.getInstance;',
    'let factory: typeof RLMContextManager.getInstance;',
    'if (Date.now() > 0) factory = RLMContextManager.getInstance; else factory = unrelated;',
    'factory();',
  ].join('\n'),
  'fixture-if-mixed-rlm-helper.ts': [
    "import { getRLMContextManager } from '../rlm/context-manager';",
    'const unrelated = (() => ({})) as typeof getRLMContextManager;',
    'let factory: typeof getRLMContextManager;',
    'if (Date.now() > 0) factory = unrelated; else factory = getRLMContextManager;',
    'factory();',
  ].join('\n'),
  'fixture-if-mixed-memory-class.ts': [
    "import { UnifiedMemoryController } from '../memory/unified-controller';",
    'const unrelated = (() => ({})) as typeof UnifiedMemoryController.getInstance;',
    'let factory: typeof UnifiedMemoryController.getInstance;',
    'if (Date.now() > 0) factory = UnifiedMemoryController.getInstance; else factory = unrelated;',
    'factory();',
  ].join('\n'),
  'fixture-if-mixed-memory-helper.ts': [
    "import { getUnifiedMemory } from '../memory/unified-controller';",
    'const unrelated = (() => ({})) as typeof getUnifiedMemory;',
    'let factory: typeof getUnifiedMemory;',
    'if (Date.now() > 0) factory = unrelated; else factory = getUnifiedMemory;',
    'factory();',
  ].join('\n'),
  'fixture-if-mixed-context.ts': [
    "import { InstanceContextManager } from './instance-context';",
    'const UnrelatedContext = class {} as unknown as typeof InstanceContextManager;',
    'let ContextCtor: typeof InstanceContextManager;',
    'if (Date.now() > 0) ContextCtor = InstanceContextManager; else ContextCtor = UnrelatedContext;',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-if-unrelated.ts': [
    "import { getRLMContextManager, RLMContextManager } from '../rlm/context-manager';",
    "import { getUnifiedMemory, UnifiedMemoryController } from '../memory/unified-controller';",
    "import { InstanceContextManager } from './instance-context';",
    'const condition = Date.now() > 0;',
    'const unrelatedRlmA = (() => ({})) as typeof RLMContextManager.getInstance;',
    'const unrelatedRlmB = (() => ({})) as typeof RLMContextManager.getInstance;',
    'const unrelatedManagerA = (() => ({})) as typeof getRLMContextManager;',
    'const unrelatedManagerB = (() => ({})) as typeof getRLMContextManager;',
    'const unrelatedControllerA = (() => ({})) as typeof UnifiedMemoryController.getInstance;',
    'const unrelatedControllerB = (() => ({})) as typeof UnifiedMemoryController.getInstance;',
    'const unrelatedMemoryA = (() => ({})) as typeof getUnifiedMemory;',
    'const unrelatedMemoryB = (() => ({})) as typeof getUnifiedMemory;',
    'const UnrelatedContextA = class {} as unknown as typeof InstanceContextManager;',
    'const UnrelatedContextB = class {} as unknown as typeof InstanceContextManager;',
    'let rlmFactory: typeof RLMContextManager.getInstance;',
    'let managerFactory: typeof getRLMContextManager;',
    'let controllerFactory: typeof UnifiedMemoryController.getInstance;',
    'let memoryFactory: typeof getUnifiedMemory;',
    'let ContextCtor: typeof InstanceContextManager;',
    'if (condition) rlmFactory = unrelatedRlmA; else rlmFactory = unrelatedRlmB;',
    'if (condition) managerFactory = unrelatedManagerB; else managerFactory = unrelatedManagerA;',
    'if (condition) controllerFactory = unrelatedControllerA; else controllerFactory = unrelatedControllerB;',
    'if (condition) memoryFactory = unrelatedMemoryB; else memoryFactory = unrelatedMemoryA;',
    'if (condition) ContextCtor = UnrelatedContextA; else ContextCtor = UnrelatedContextB;',
    'rlmFactory();',
    'managerFactory();',
    'controllerFactory();',
    'memoryFactory();',
    'new ContextCtor();',
  ].join('\n'),
  'fixture-ambiguous-write.ts': [
    "import { getRLMContextManager } from '../rlm/context-manager';",
    'const unrelated = (() => { throw new Error(); }) as typeof getRLMContextManager;',
    'let factory = getRLMContextManager;',
    'if (Date.now() > 0) factory = unrelated;',
    'factory();',
  ].join('\n'),
  'fixture-reexport-entry.ts': [
    "import { Manager } from './fixture-reexport';",
    'Manager.getInstance();',
  ].join('\n'),
  'fixture-reexport.ts': [
    "export { RLMContextManager as Manager } from '../rlm/context-manager';",
  ].join('\n'),
  'fixture-configured-alias.ts': [
    "import { generateId } from '@shared/utils/id-generator';",
    'void generateId();',
  ].join('\n'),
};
let semanticFixtureProgram: ts.Program | undefined;

function getSemanticFixtureProgram(): ts.Program {
  return semanticFixtureProgram ??= createOwnershipProgram(semanticFixtureSources);
}

function analyzeFixtureOwnerCalls(rootName: keyof typeof semanticFixtureSources): OwnerCallManifestEntry[] {
  const program = getSemanticFixtureProgram();
  const root = resolve(mainRoot, 'instance', rootName);
  return ownerCallsInClosure(program, 'fixture', runtimeClosure(program, root));
}

function semanticDiagnosticMessages(
  program: ts.Program,
  source: ts.SourceFile | undefined,
): string[] {
  return program.getSemanticDiagnostics(source).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

function manifestDifferences(
  observed: OwnerCallManifestEntry[],
  expected: OwnerCallManifestEntry[],
): string[] {
  const format = (prefix: '-' | '+', entry: OwnerCallManifestEntry) =>
    `${prefix} ${entry.role} ${entry.file} ${entry.callee} x${entry.count}`;
  const key = (entry: OwnerCallManifestEntry) => JSON.stringify(entry);
  const remainingObserved = new Map<string, number>();
  for (const entry of observed) {
    remainingObserved.set(key(entry), (remainingObserved.get(key(entry)) ?? 0) + 1);
  }
  const differences: string[] = [];
  for (const entry of expected) {
    const entryKey = key(entry);
    const remaining = remainingObserved.get(entryKey) ?? 0;
    if (remaining === 0) differences.push(format('-', entry));
    else remainingObserved.set(entryKey, remaining - 1);
  }
  for (const entry of observed) {
    const entryKey = key(entry);
    const remaining = remainingObserved.get(entryKey) ?? 0;
    if (remaining > 0) {
      differences.push(format('+', entry));
      remainingObserved.set(entryKey, remaining - 1);
    }
  }
  return differences;
}

function makeFakeWorker() {
  const worker = new EventEmitter();
  const postMessage = vi.fn((message: ContextWorkerInboundMsg) => {
    if (message.type === 'rlm-request') {
      queueMicrotask(() => worker.emit('message', {
        type: 'rpc-response',
        id: message.id,
        result: [],
      }));
    } else if (message.type === 'shutdown') {
      queueMicrotask(() => worker.emit('message', {
        type: 'rpc-response',
        id: message.id,
        result: undefined,
      }));
    }
  });
  return Object.assign(worker, {
    postMessage,
    terminate: vi.fn().mockResolvedValue(0),
  });
}

interface CleanupTask {
  label: string;
  run(): void | Promise<void>;
}

interface CleanupFailure {
  label: string;
  error: unknown;
}

async function runCleanupTasks(tasks: CleanupTask[]): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    const task = tasks[index];
    try {
      await task.run();
    } catch (error) {
      failures.push({ label: task.label, error });
    }
  }
  return failures;
}

async function runWithCleanup<T>(
  body: (registerCleanup: (task: CleanupTask) => void) => Promise<T>,
): Promise<T> {
  const tasks: CleanupTask[] = [];
  let result: T | undefined;
  let bodyError: unknown;
  try {
    result = await body((task) => tasks.push(task));
  } catch (error) {
    bodyError = error;
  }
  const cleanupFailures = await runCleanupTasks(tasks);
  if (bodyError !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      [
        ...(bodyError === undefined ? [] : [bodyError]),
        ...cleanupFailures.map((failure) => failure.error),
      ],
      'Ownership scenario or cleanup failed',
    );
  }
  return result as T;
}

const cleanupIsolationProbe = {
  ipcDirty: false,
  singletonDirty: false,
  tempDirty: false,
};

interface BootstrapFailureResidue {
  directory: string;
  recents: EventEmitter;
  relay: EventEmitter;
  scenarioWatcher: EventEmitter & {
    getActiveWatchers(): string[];
    stopAll(): Promise<void>;
  };
  defaultWatcher: EventEmitter & {
    getActiveWatchers(): string[];
    stopAll(): Promise<void>;
  };
  workerClient: object;
  workerModule: typeof import('./context-worker-client');
  watcherModule: typeof import('../indexing/file-watcher');
  autoCoordinator: EventEmitter;
}

let bootstrapFailureResidue: BootstrapFailureResidue | undefined;

interface BootstrapScenarioResources extends BootstrapFailureResidue {
  attempts: string[];
  manager: { destroy(): void };
  coordinator: { stop(): void };
  registration: { dispose(): Promise<void> };
  fakeWorker: ReturnType<typeof makeFakeWorker>;
  workerFactory: ReturnType<typeof vi.fn>;
  codebaseRegistration: { dispose(): void };
  unifiedMemoryPort: { invokeUnifiedMemory: ReturnType<typeof vi.fn> };
}

interface BootstrapScenarioOptions {
  name: string;
  attempts: string[];
  cleanupError?: Error;
  afterHandlers?(resources: Partial<BootstrapScenarioResources>): void | Promise<void>;
  failCodebaseChannel?: string;
  observeCodebaseRollback?(clean: boolean): void;
}

async function acquireBootstrapScenario(
  registerCleanup: (task: CleanupTask) => void,
  options: BootstrapScenarioOptions,
): Promise<BootstrapScenarioResources> {
  const { attempts } = options;
  const resources: Partial<BootstrapScenarioResources> = { attempts };
  registerCleanup({
    label: 'IPC handlers',
    run: () => {
      attempts.push('ipc-reset');
      electronMocks.handlers.clear();
    },
  });

  const directory = mkdtempSync(resolve(tmpdir(), `aio-rlm-ownership-${options.name}-`));
  resources.directory = directory;
  registerCleanup({
    label: 'temporary directory',
    run: () => {
      attempts.push('temp-remove');
      rmSync(directory, { recursive: true, force: true });
    },
  });

  const workerModule = await import('./context-worker-client');
  const fakeWorker = makeFakeWorker();
  const workerFactory = vi.fn(() => fakeWorker as never);
  const workerClient = workerModule.getContextWorkerClient({
    userDataPath: `/tmp/rlm-process-ownership-${options.name}`,
    workerFactory,
    rpcTimeoutMs: 100,
  });
  Object.assign(resources, { workerModule, fakeWorker, workerFactory, workerClient });
  registerCleanup({
    label: 'context worker singleton',
    run: async () => {
      attempts.push('worker-shutdown:start');
      await workerClient.shutdown();
      attempts.push('worker-shutdown:end');
      workerModule._resetContextWorkerClientForTesting();
    },
  });

  const watcherModule = await import('../indexing/file-watcher');
  const defaultWatcher = watcherModule.getCodebaseFileWatcher();
  defaultWatcher.stopAll = vi.fn(defaultWatcher.stopAll.bind(defaultWatcher));
  Object.assign(resources, { watcherModule, defaultWatcher });
  registerCleanup({
    label: 'default file watcher singleton',
    run: async () => {
      attempts.push('default-watcher-stop:start');
      await defaultWatcher.stopAll();
      attempts.push('default-watcher-stop:end');
      defaultWatcher.removeAllListeners();
      watcherModule.resetCodebaseFileWatcher();
    },
  });

  const autoModule = await import('../indexing/codebase-indexing-auto-coordinator');
  const autoCoordinator = autoModule.getCodebaseIndexingAutoCoordinator();
  resources.autoCoordinator = autoCoordinator;
  registerCleanup({
    label: 'auto-index singleton',
    run: () => {
      attempts.push('auto-reset');
      autoCoordinator.stop();
      autoCoordinator.removeAllListeners();
      autoModule.resetCodebaseIndexingAutoCoordinatorForTesting();
    },
  });

  const relayModule = await import('./context-worker-event-relay');
  const relay = relayModule.getContextWorkerEventRelay();
  relay.on('store:created', vi.fn());
  resources.relay = relay;
  registerCleanup({
    label: 'worker event relay',
    run: () => {
      attempts.push('relay-reset');
      relayModule._resetContextWorkerEventRelayForTesting();
    },
  });

  const windowManager = { sendToRenderer: vi.fn() };
  const runtimeWiring = await import('../ipc/ipc-main-runtime-wiring');
  runtimeWiring.setupRlmEventForwarding(windowManager as never);
  registerCleanup({
    label: 'runtime event wiring',
    run: () => {
      attempts.push('runtime-teardown');
      runtimeWiring.teardownRlmEventForwarding();
    },
  });

  const memoryHandlers = await import('../ipc/memory-ipc-handler');
  const unifiedMemoryPort = {
    invokeUnifiedMemory: vi.fn(async () => ({ totalSessions: 0 })),
  };
  resources.unifiedMemoryPort = unifiedMemoryPort;
  memoryHandlers.registerMemoryHandlers({ unifiedMemoryPort: unifiedMemoryPort as never });
  const codebaseHandlers = await import('../ipc/handlers/codebase-handlers');
  const handlerBaseline = new Map(electronMocks.handlers);
  const listenerBaseline = {
    lane: bootstrapFakes.lane.listenerCount('progress'),
    watcher: defaultWatcher.listenerCount('changes:processed'),
    auto: autoCoordinator.listenerCount('status'),
  };
  electronMocks.failHandleChannel = options.failCodebaseChannel ?? null;
  let codebaseRegistration: { dispose(): void };
  try {
    codebaseRegistration = codebaseHandlers.registerCodebaseHandlers(windowManager as never);
  } catch (error) {
    options.observeCodebaseRollback?.(
      [...electronMocks.handlers.entries()].every(([channel, handler]) => (
        handlerBaseline.get(channel) === handler
      ))
      && electronMocks.handlers.size === handlerBaseline.size
      && bootstrapFakes.lane.listenerCount('progress') === listenerBaseline.lane
      && defaultWatcher.listenerCount('changes:processed') === listenerBaseline.watcher
      && autoCoordinator.listenerCount('status') === listenerBaseline.auto,
    );
    throw error;
  } finally {
    electronMocks.failHandleChannel = null;
  }
  resources.codebaseRegistration = codebaseRegistration;
  registerCleanup({
    label: 'codebase handler registration',
    run: () => {
      attempts.push('codebase-handlers-dispose');
      codebaseRegistration.dispose();
    },
  });
  await options.afterHandlers?.(resources);

  const scenarioWatcher = new watcherModule.CodebaseFileWatcher({}, bootstrapFakes.lane);
  scenarioWatcher.stopAll = vi.fn(scenarioWatcher.stopAll.bind(scenarioWatcher));
  resources.scenarioWatcher = scenarioWatcher;
  registerCleanup({
    label: 'scenario file watcher',
    run: async () => {
      attempts.push('scenario-watcher-stop:start');
      await scenarioWatcher.stopAll();
      attempts.push('scenario-watcher-stop:end');
    },
  });
  const registration = await scenarioWatcher.startWatching(`${options.name}-store`, directory);
  registration.dispose = vi.fn(registration.dispose.bind(registration));
  resources.registration = registration;
  registerCleanup({
    label: 'scenario watcher registration',
    run: async () => {
      attempts.push('registration-dispose:start');
      await registration.dispose();
      attempts.push('registration-dispose:end');
      if (options.cleanupError) throw options.cleanupError;
    },
  });

  const recents = new EventEmitter();
  resources.recents = recents;
  const coordinator = new autoModule.CodebaseIndexingAutoCoordinator({
    recentDirectoriesManager: recents,
    indexingService: bootstrapFakes.lane,
    fileWatcher: scenarioWatcher,
    contextManager: {
      createStore: async (id: string) => ({ id }),
      listStores: async () => [],
    },
    registry: { canAutoMine: () => true },
    settings: { get: (key) => (key === 'codebaseAutoIndexEnabled' ? true : undefined) as never },
    preflight: async () => ({ fileCount: 0, totalBytes: 0 }),
  });
  coordinator.stop = vi.fn(coordinator.stop.bind(coordinator));
  resources.coordinator = coordinator;
  registerCleanup({
    label: 'auto-index coordinator',
    run: () => {
      attempts.push('coordinator-stop');
      coordinator.stop();
    },
  });
  coordinator.start();

  const managerModule = await import('./instance-manager');
  const manager = new managerModule.InstanceManager();
  manager.destroy = vi.fn(manager.destroy.bind(manager));
  resources.manager = manager;
  registerCleanup({
    label: 'instance manager',
    run: () => {
      attempts.push('manager-destroy');
      manager.destroy();
    },
  });
  expect((manager as unknown as { context: object }).context).toBe(workerClient);
  return resources as BootstrapScenarioResources;
}

describe('RLM process ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.handlers.clear();
    electronMocks.failHandleChannel = null;
    electronMocks.handleError = null;
    ownerImportProbe.contextManagerResolutions = 0;
    ownerImportProbe.indexingServiceResolutions = 0;
    ownerImportProbe.instanceContextResolutions = 0;
    ownerImportProbe.unifiedControllerResolutions = 0;
    ownerImportProbe.memoryBarrelResolutions = 0;
  });

  afterEach(async () => {
    const imports = await Promise.allSettled([
      import('../ipc/ipc-main-runtime-wiring'),
      import('./context-worker-event-relay'),
      import('./context-worker-client'),
    ]);
    const cleanupTasks: CleanupTask[] = [
      { label: 'IPC handlers', run: () => electronMocks.handlers.clear() },
    ];
    const contextWorkerClient = imports[2];
    if (contextWorkerClient.status === 'fulfilled') {
      cleanupTasks.push({
        label: 'context worker singleton',
        run: () => contextWorkerClient.value._resetContextWorkerClientForTesting(),
      });
    }
    const workerEventRelay = imports[1];
    if (workerEventRelay.status === 'fulfilled') {
      cleanupTasks.push({
        label: 'worker event relay',
        run: () => workerEventRelay.value._resetContextWorkerEventRelayForTesting(),
      });
    }
    const runtimeWiring = imports[0];
    if (runtimeWiring.status === 'fulfilled') {
      cleanupTasks.push({
        label: 'runtime wiring',
        run: () => runtimeWiring.value.teardownRlmEventForwarding(),
      });
    }
    const cleanupErrors = await runCleanupTasks(cleanupTasks);
    const importErrors = imports.flatMap((outcome) => outcome.status === 'rejected'
      ? [outcome.reason]
      : []);
    if (importErrors.length > 0 || cleanupErrors.length > 0) {
      throw new AggregateError(
        [...importErrors, ...cleanupErrors.map((failure) => failure.error)],
        'Ownership afterEach cleanup failed',
      );
    }
  });

  it('attempts every registered cleanup after partial setup/body and cleanup failures', async () => {
    cleanupIsolationProbe.ipcDirty = true;
    cleanupIsolationProbe.singletonDirty = true;
    cleanupIsolationProbe.tempDirty = true;
    const attempts: string[] = [];
    const bodyError = new Error('injected body failure');
    let observedError: unknown;
    try {
      await runWithCleanup(async (registerCleanup) => {
        attempts.push('partial-setup');
        registerCleanup({
          label: 'rejected cleanup',
          run: async () => {
            attempts.push('rejected-cleanup');
            throw new Error('injected cleanup failure');
          },
        });
        registerCleanup({
          label: 'IPC reset',
          run: () => {
            attempts.push('ipc-reset');
            cleanupIsolationProbe.ipcDirty = false;
          },
        });
        registerCleanup({
          label: 'singleton reset',
          run: () => {
            attempts.push('singleton-reset');
            cleanupIsolationProbe.singletonDirty = false;
          },
        });
        registerCleanup({
          label: 'temporary directory removal',
          run: () => {
            attempts.push('temp-reset');
            cleanupIsolationProbe.tempDirty = false;
          },
        });
        throw bodyError;
      });
    } catch (error) {
      observedError = error;
    }

    expect(observedError).toBeInstanceOf(AggregateError);
    expect((observedError as AggregateError).errors).toEqual([
      bodyError,
      expect.objectContaining({ message: 'injected cleanup failure' }),
    ]);
    expect(attempts).toEqual([
      'partial-setup',
      'temp-reset',
      'singleton-reset',
      'ipc-reset',
      'rejected-cleanup',
    ]);
  });

  it('starts the next test with cleanup-isolation probes reset', () => {
    expect(cleanupIsolationProbe).toEqual({
      ipcDirty: false,
      singletonDirty: false,
      tempDirty: false,
    });
  });

  it('cleans shared bootstrap acquisition after a handler-stage setup rejection', async () => {
    vi.resetModules();
    const attempts: string[] = [];
    const setupError = new Error('injected bootstrap setup rejection');
    let partial: Partial<BootstrapScenarioResources> | undefined;
    let observedError: unknown;

    try {
      await runWithCleanup(async (registerCleanup) => acquireBootstrapScenario(
        registerCleanup,
        {
          name: 'setup-failure-shared',
          attempts,
          afterHandlers: (resources) => {
            partial = resources;
            throw setupError;
          },
        },
      ));
    } catch (error) {
      observedError = error;
    }

    expect(observedError).toBeInstanceOf(AggregateError);
    expect((observedError as AggregateError).errors).toEqual([setupError]);
    expect(attempts).toEqual([
      'codebase-handlers-dispose',
      'runtime-teardown',
      'relay-reset',
      'auto-reset',
      'default-watcher-stop:start',
      'default-watcher-stop:end',
      'worker-shutdown:start',
      'worker-shutdown:end',
      'temp-remove',
      'ipc-reset',
    ]);
    expect(electronMocks.handlers.size).toBe(0);
    expect(bootstrapFakes.lane.listenerCount('progress')).toBe(0);
    expect(partial?.defaultWatcher?.listenerCount('changes:processed')).toBe(0);
    expect(partial?.autoCoordinator?.listenerCount('status')).toBe(0);
    expect(existsSync(partial?.directory ?? '')).toBe(false);
  }, 20_000);

  it('keeps shared bootstrap acquisition clean after transactional handler rollback', async () => {
    vi.resetModules();
    const attempts: string[] = [];
    const registrationError = new Error('injected codebase handler registration failure');
    let rollbackWasClean = false;
    let observedError: unknown;
    electronMocks.handleError = registrationError;

    try {
      await runWithCleanup(async (registerCleanup) => acquireBootstrapScenario(
        registerCleanup,
        {
          name: 'transactional-handler-failure',
          attempts,
          failCodebaseChannel: IPC_CHANNELS.CODEBASE_INDEX_STATS,
          observeCodebaseRollback: (clean) => {
            rollbackWasClean = clean;
          },
        },
      ));
    } catch (error) {
      observedError = error;
    }

    expect(observedError).toBeInstanceOf(AggregateError);
    expect((observedError as AggregateError).errors).toEqual([registrationError]);
    expect(rollbackWasClean).toBe(true);
    expect(attempts).toEqual([
      'runtime-teardown',
      'relay-reset',
      'auto-reset',
      'default-watcher-stop:start',
      'default-watcher-stop:end',
      'worker-shutdown:start',
      'worker-shutdown:end',
      'temp-remove',
      'ipc-reset',
    ]);
    expect(electronMocks.handlers.size).toBe(0);
    expect(bootstrapFakes.lane.listenerCount('progress')).toBe(0);
  }, 20_000);

  it('cleans shared full bootstrap acquisition after body and cleanup failures', async () => {
    vi.resetModules();
    const attempts: string[] = [];
    const bodyError = new Error('injected bootstrap body failure');
    const cleanupError = new Error('injected watcher registration cleanup failure');
    let resources: BootstrapScenarioResources | undefined;
    let observedError: unknown;

    try {
      await runWithCleanup(async (registerCleanup) => {
        resources = await acquireBootstrapScenario(registerCleanup, {
          name: 'body-failure-shared',
          attempts,
          cleanupError,
        });
        bootstrapFailureResidue = resources;
        throw bodyError;
      });
    } catch (error) {
      observedError = error;
    }

    expect(observedError).toBeInstanceOf(AggregateError);
    expect((observedError as AggregateError).errors).toEqual([bodyError, cleanupError]);
    expect(attempts).toEqual([
      'manager-destroy',
      'coordinator-stop',
      'registration-dispose:start',
      'registration-dispose:end',
      'scenario-watcher-stop:start',
      'scenario-watcher-stop:end',
      'codebase-handlers-dispose',
      'runtime-teardown',
      'relay-reset',
      'auto-reset',
      'default-watcher-stop:start',
      'default-watcher-stop:end',
      'worker-shutdown:start',
      'worker-shutdown:end',
      'temp-remove',
      'ipc-reset',
    ]);
    expect(resources?.registration.dispose).toHaveBeenCalledOnce();
    expect(resources?.scenarioWatcher.stopAll).toHaveBeenCalledOnce();
    expect(resources?.manager.destroy).toHaveBeenCalledOnce();
    expect(resources?.fakeWorker.terminate).toHaveBeenCalledOnce();
  }, 20_000);

  it('starts the next shared bootstrap test with every actual resource isolated', async () => {
    const residue = bootstrapFailureResidue;
    expect(residue).toBeDefined();
    expect(electronMocks.handlers.size).toBe(0);
    expect(residue?.recents.listenerCount('directory-added')).toBe(0);
    expect(residue?.relay.eventNames()).toEqual([]);
    expect(residue?.scenarioWatcher.getActiveWatchers()).toEqual([]);
    expect(residue?.defaultWatcher.getActiveWatchers()).toEqual([]);
    expect(bootstrapFakes.lane.listenerCount('progress')).toBe(0);
    expect(residue?.defaultWatcher.listenerCount('changes:processed')).toBe(0);
    expect(residue?.autoCoordinator.listenerCount('status')).toBe(0);
    expect(existsSync(residue?.directory ?? '')).toBe(false);

    const nextWorker = residue?.workerModule.getContextWorkerClient({
      userDataPath: '/tmp/rlm-process-ownership-shared-isolation',
      workerFactory: () => makeFakeWorker() as never,
      rpcTimeoutMs: 100,
    });
    expect(nextWorker).not.toBe(residue?.workerClient);
    await nextWorker?.shutdown();
    residue?.workerModule._resetContextWorkerClientForTesting();
    const nextWatcher = residue?.watcherModule.getCodebaseFileWatcher();
    expect(nextWatcher).not.toBe(residue?.defaultWatcher);
    await nextWatcher?.stopAll();
    residue?.watcherModule.resetCodebaseFileWatcher();
    bootstrapFailureResidue = undefined;
  });

  it('boots through the shared real acquisition path while owner factories stay trapped', async () => {
    vi.resetModules();
    const attempts: string[] = [];
    let resources: BootstrapScenarioResources | undefined;

    await runWithCleanup(async (registerCleanup) => {
      resources = await acquireBootstrapScenario(registerCleanup, {
        name: 'passing-shared',
        attempts,
      });
      expect(electronMocks.handlers.has(IPC_CHANNELS.UNIFIED_MEMORY_GET_STATS)).toBe(true);
      expect(electronMocks.handlers.has(IPC_CHANNELS.CODEBASE_INDEX_STORE)).toBe(true);

      const memoryStats = await electronMocks.handlers.get(
        IPC_CHANNELS.UNIFIED_MEMORY_GET_STATS,
      )?.({}, undefined);
      expect(memoryStats).toEqual({ success: true, data: { totalSessions: 0 } });
      expect(resources.unifiedMemoryPort.invokeUnifiedMemory).toHaveBeenCalledWith({
        kind: 'get-stats',
      });

      const codebaseStats = await electronMocks.handlers.get(
        IPC_CHANNELS.CODEBASE_INDEX_STORE,
      )?.({}, {
        storeId: 'passing-shared-store',
        rootPath: resources.directory,
        options: { force: true },
      });
      expect(codebaseStats).toEqual({
        success: true,
        data: {
          filesIndexed: 0,
          chunksCreated: 0,
          tokensProcessed: 0,
          duration: 0,
          errors: [],
        },
      });
      expect(bootstrapFakes.lane.indexCodebase).toHaveBeenCalledWith(
        'passing-shared-store',
        resources.directory,
        { force: true },
      );
      expect(resources.recents.listenerCount('directory-added')).toBe(1);
      expect(ownerImportProbe).toEqual({
        contextManagerResolutions: 0,
        indexingServiceResolutions: 0,
        instanceContextResolutions: 0,
        unifiedControllerResolutions: 0,
        memoryBarrelResolutions: 0,
      });
    });

    expect(resources?.manager.destroy).toHaveBeenCalledOnce();
    expect(resources?.coordinator.stop).toHaveBeenCalledOnce();
    expect(resources?.registration.dispose).toHaveBeenCalledOnce();
    expect(resources?.defaultWatcher.stopAll).toHaveBeenCalledTimes(2);
    expect(resources?.workerFactory).toHaveBeenCalledOnce();
    expect(resources?.fakeWorker.terminate).toHaveBeenCalledOnce();
    expect(resources?.recents.listenerCount('directory-added')).toBe(0);
    expect(bootstrapFakes.lane.listenerCount('progress')).toBe(0);
    expect(resources?.defaultWatcher.listenerCount('changes:processed')).toBe(0);
    expect(resources?.autoCoordinator.listenerCount('status')).toBe(0);
  }, 20_000);

  it('imports the main facade modules without resolving an RLM or unified-memory owner', async () => {
    vi.resetModules();

    const [bootstrap, learning, memory, runtimeWiring, relay, orchestration] = await Promise.all([
      import('../bootstrap/memory-bootstrap'),
      import('../ipc/learning-ipc-handler'),
      import('../ipc/memory-ipc-handler'),
      import('../ipc/ipc-main-runtime-wiring'),
      import('./context-worker-event-relay'),
      import('./instance-orchestration'),
    ]);

    expect(bootstrap.registerMemoryBootstrap).toBeTypeOf('function');
    expect(learning.registerLearningHandlers).toBeTypeOf('function');
    expect(memory.registerMemoryHandlers).toBeTypeOf('function');
    expect(runtimeWiring.setupRlmEventForwarding).toBeTypeOf('function');
    expect(relay.dispatchWorkerBroadcast).toBeTypeOf('function');
    expect(orchestration.InstanceOrchestrationManager).toBeTypeOf('function');
    expect(ownerImportProbe).toEqual({
      contextManagerResolutions: 0,
      indexingServiceResolutions: 0,
      instanceContextResolutions: 0,
      unifiedControllerResolutions: 0,
      memoryBarrelResolutions: 0,
    });
  });

  it('imports auto-index and indexed prompt-context facades without resolving a main RLM owner', async () => {
    vi.resetModules();
    vi.doUnmock('./orchestration/fast-path-retriever');

    const [autoDefaults, indexedContext, systemPrompt, fastPath] = await Promise.all([
      import('../indexing/codebase-indexing-auto-defaults'),
      import('../indexing/indexed-codebase-context'),
      import('./instance-system-prompt'),
      import('./orchestration/fast-path-retriever'),
    ]);

    expect(autoDefaults.createDefaultContextManagerTarget).toBeTypeOf('function');
    expect(indexedContext.getIndexedCodebaseContextService).toBeTypeOf('function');
    expect(systemPrompt.assembleInstanceSystemPrompt).toBeTypeOf('function');
    expect(fastPath.FastPathRetriever).toBeTypeOf('function');
    expect(ownerImportProbe.contextManagerResolutions).toBe(0);
  });

  it('uses one worker facade for learning RPC and renderer event delivery', async () => {
    vi.resetModules();
    const fakeWorker = makeFakeWorker();
    const workerFactory = vi.fn(() => fakeWorker as never);
    const { ContextWorkerClient } = await import('./context-worker-client');
    const client = new ContextWorkerClient({
      userDataPath: '/tmp/rlm-process-ownership-spec',
      workerFactory,
      rpcTimeoutMs: 100,
    });

    try {
      const { registerLearningHandlers } = await import('../ipc/learning-ipc-handler');
      const runtimeWiring = await import('../ipc/ipc-main-runtime-wiring');
      registerLearningHandlers({ rlmPort: client });
      const windowManager = { sendToRenderer: vi.fn() };
      runtimeWiring.setupRlmEventForwarding(windowManager as never);

      const listStores = electronMocks.handlers.get('rlm:list-stores');
      await expect(listStores?.({}, undefined)).resolves.toEqual({ success: true, data: [] });

      const store = {
        id: 'store-worker-owned',
        instanceId: 'instance-worker-owned',
        sections: [],
        totalTokens: 0,
        totalSize: 0,
        createdAt: 1,
        lastAccessed: 2,
        accessCount: 1,
      };
      fakeWorker.emit('message', {
        type: 'worker-event',
        source: 'rlm-context',
        event: 'store:created',
        payload: store,
      });

      expect(workerFactory).toHaveBeenCalledOnce();
      expect(fakeWorker.postMessage).toHaveBeenCalledOnce();
      expect(fakeWorker.postMessage).toHaveBeenCalledWith({
        type: 'rlm-request',
        id: 1,
        request: { kind: 'list-stores' },
      });
      expect(windowManager.sendToRenderer).toHaveBeenCalledOnce();
      expect(windowManager.sendToRenderer).toHaveBeenCalledWith(
        'rlm:store-updated',
        { storeId: store.id, store },
      );
      expect(ownerImportProbe).toEqual({
        contextManagerResolutions: 0,
        indexingServiceResolutions: 0,
        instanceContextResolutions: 0,
        unifiedControllerResolutions: 0,
        memoryBarrelResolutions: 0,
      });
    } finally {
      await client.shutdown();
    }
  });

  it('finds unused value/dynamic owner imports but ignores type-only imports', () => {
    const references = runtimeModuleReferences([
      "import { RLMContextManager } from '../rlm/context-manager';",
      "import type { RLMContextManager as ManagerType } from '../rlm/context-manager';",
      "import { type RLMContextManager as InlineType } from '../rlm/context-manager';",
      "const unused = () => import('../memory/unified-controller');",
      "void require('../rlm/context-manager');",
    ].join('\n'));

    expect(references).toEqual([
      {
        specifier: '../rlm/context-manager',
        importedNames: ['RLMContextManager'],
        kind: 'import',
      },
      {
        specifier: '../memory/unified-controller',
        importedNames: ['*'],
        kind: 'dynamic-import',
      },
      {
        specifier: '../rlm/context-manager',
        importedNames: ['*'],
        kind: 'require',
      },
    ]);
  });

  it('matches the exact entrypoint-rooted owner-call manifest', () => {
    const analysis = analyzeProductionOwnership();
    const expectedManifest: OwnerCallManifestEntry[] = [
      { role: 'context-worker', file: 'instance/context-worker-main.ts', callee: 'getUnifiedMemory', count: 1 },
      { role: 'context-worker', file: 'instance/context-worker-main.ts', callee: 'new InstanceContextManager', count: 1 },
      { role: 'context-worker', file: 'instance/context-worker-main.ts', callee: 'RLMContextManager.getInstance', count: 6 },
      { role: 'context-worker', file: 'instance/instance-context.ts', callee: 'getUnifiedMemory', count: 1 },
      { role: 'context-worker', file: 'instance/instance-context.ts', callee: 'RLMContextManager.getInstance', count: 1 },
      { role: 'context-worker', file: 'memory/unified-controller.ts', callee: 'RLMContextManager.getInstance', count: 1 },
      { role: 'context-worker', file: 'memory/unified-controller.ts', callee: 'UnifiedMemoryController.getInstance', count: 1 },
      { role: 'context-worker', file: 'rlm/context-manager.ts', callee: 'RLMContextManager.getInstance', count: 1 },
      { role: 'indexing-lane', file: 'indexing/codebase-indexing-lane-main.ts', callee: 'RLMContextManager.getInstance', count: 2 },
      { role: 'indexing-lane', file: 'indexing/indexing-service.ts', callee: 'RLMContextManager.getInstance', count: 1 },
      { role: 'indexing-lane', file: 'rlm/context-manager.ts', callee: 'RLMContextManager.getInstance', count: 1 },
    ];

    expect(Object.keys(analysis.closures).sort()).toEqual([
      'context-worker',
      'electron-main',
      'indexing-lane',
    ]);
    expect(analysis.closures['electron-main']).toContain('index.ts');
    expect(analysis.closures['electron-main']).not.toEqual(expect.arrayContaining([
      'indexing/index.ts',
      'indexing/indexing-service.ts',
      'instance/instance-context.ts',
      'memory/index.ts',
      'memory/unified-controller.ts',
      'rlm/context-manager.ts',
    ]));
    expect(manifestDifferences(analysis.calls, expectedManifest)).toEqual([]);
  }, 15_000);

  it('detects owner calls through named aliases and namespace imports', () => {
    const calls = analyzeFixtureOwnerCalls('fixture-alias.ts')
      .filter((call) => call.file === 'instance/fixture-alias.ts');

    expect(calls).toEqual([
      { role: 'fixture', file: 'instance/fixture-alias.ts', callee: 'getRLMContextManager', count: 1 },
      { role: 'fixture', file: 'instance/fixture-alias.ts', callee: 'getUnifiedMemory', count: 1 },
      { role: 'fixture', file: 'instance/fixture-alias.ts', callee: 'new InstanceContextManager', count: 1 },
      { role: 'fixture', file: 'instance/fixture-alias.ts', callee: 'RLMContextManager.getInstance', count: 1 },
      { role: 'fixture', file: 'instance/fixture-alias.ts', callee: 'UnifiedMemoryController.getInstance', count: 1 },
    ]);
  }, 15_000);

  it('detects immutable local alias chains for every owner call form', () => {
    const program = getSemanticFixtureProgram();
    const source = program.getSourceFile(resolve(mainRoot, 'instance/fixture-local-alias.ts'));
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls('fixture-local-alias.ts')
      .filter((call) => call.file === 'instance/fixture-local-alias.ts');

    expect(calls).toEqual([
      { role: 'fixture', file: 'instance/fixture-local-alias.ts', callee: 'getRLMContextManager', count: 1 },
      { role: 'fixture', file: 'instance/fixture-local-alias.ts', callee: 'getUnifiedMemory', count: 1 },
      { role: 'fixture', file: 'instance/fixture-local-alias.ts', callee: 'new InstanceContextManager', count: 1 },
      { role: 'fixture', file: 'instance/fixture-local-alias.ts', callee: 'RLMContextManager.getInstance', count: 1 },
      { role: 'fixture', file: 'instance/fixture-local-alias.ts', callee: 'UnifiedMemoryController.getInstance', count: 1 },
    ]);
  });

  it('detects destructured/property aliases without matching local shadows', () => {
    const program = getSemanticFixtureProgram();
    const source = program.getSourceFile(resolve(mainRoot, 'instance/fixture-property-alias.ts'));
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls('fixture-property-alias.ts')
      .filter((call) => call.file === 'instance/fixture-property-alias.ts');

    expect(calls).toEqual([
      { role: 'fixture', file: 'instance/fixture-property-alias.ts', callee: 'getRLMContextManager', count: 1 },
      { role: 'fixture', file: 'instance/fixture-property-alias.ts', callee: 'getUnifiedMemory', count: 1 },
      { role: 'fixture', file: 'instance/fixture-property-alias.ts', callee: 'new InstanceContextManager', count: 1 },
      { role: 'fixture', file: 'instance/fixture-property-alias.ts', callee: 'RLMContextManager.getInstance', count: 1 },
      { role: 'fixture', file: 'instance/fixture-property-alias.ts', callee: 'UnifiedMemoryController.getInstance', count: 1 },
    ]);
  });

  it.each([
    'fixture-computed-property-alias.ts',
    'fixture-readonly-property-alias.ts',
    'fixture-let-write-alias.ts',
  ] as const)('detects ordered owner values in %s', (fixture) => {
    const program = getSemanticFixtureProgram();
    const source = program.getSourceFile(resolve(mainRoot, 'instance', fixture));
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls(fixture)
      .filter((call) => call.file === `instance/${fixture}`);

    expect(calls.map(({ callee, count }) => ({ callee, count }))).toEqual([
      { callee: 'getRLMContextManager', count: 1 },
      { callee: 'getUnifiedMemory', count: 1 },
      { callee: 'new InstanceContextManager', count: 1 },
      { callee: 'RLMContextManager.getInstance', count: 1 },
      { callee: 'UnifiedMemoryController.getInstance', count: 1 },
    ]);
  });

  it('uses the final ordered property write instead of its owner initializer', () => {
    const program = getSemanticFixtureProgram();
    const source = program.getSourceFile(resolve(mainRoot, 'instance/fixture-mutable-overwrite.ts'));
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls('fixture-mutable-overwrite.ts')
      .filter((call) => call.file === 'instance/fixture-mutable-overwrite.ts');

    expect(calls).toEqual([]);
  });

  it('does not treat a function-local require binding as the CommonJS loader', () => {
    const program = getSemanticFixtureProgram();
    const root = resolve(mainRoot, 'instance/fixture-shadow-require.ts');
    const source = program.getSourceFile(root);
    expect(program.getSemanticDiagnostics(source)).toEqual([]);

    const closure = [...runtimeClosure(program, root)].map((file) => relative(mainRoot, file));
    expect(closure).toEqual(['instance/fixture-shadow-require.ts']);
    expect(ownerCallsInClosure(program, 'fixture', new Set([root]))).toEqual([]);
  });

  it.each([
    'fixture-require-direct.ts',
    'fixture-require-destructured.ts',
    'fixture-require-namespace.ts',
    'fixture-require-object-alias.ts',
    'fixture-require-nested-shorthand.ts',
  ] as const)('detects every owner call through literal CommonJS values in %s', (fixture) => {
    const program = getSemanticFixtureProgram();
    const source = program.getSourceFile(resolve(mainRoot, 'instance', fixture));
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls(fixture)
      .filter((call) => call.file === `instance/${fixture}`);
    expect(calls.map(({ callee, count }) => ({ callee, count }))).toEqual([
      { callee: 'getRLMContextManager', count: 1 },
      { callee: 'getUnifiedMemory', count: 1 },
      { callee: 'new InstanceContextManager', count: 1 },
      { callee: 'RLMContextManager.getInstance', count: 1 },
      { callee: 'UnifiedMemoryController.getInstance', count: 1 },
    ]);
  });

  it('detects readonly tuple destructuring and alias chains for every owner form', () => {
    const program = getSemanticFixtureProgram();
    const fixture = 'fixture-readonly-tuple.ts';
    const source = program.getSourceFile(resolve(mainRoot, 'instance', fixture));
    expect(program.getSemanticDiagnostics(source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls(fixture)
      .filter((call) => call.file === `instance/${fixture}`);
    expect(calls.map(({ callee, count }) => ({ callee, count }))).toEqual([
      { callee: 'getRLMContextManager', count: 1 },
      { callee: 'getUnifiedMemory', count: 1 },
      { callee: 'new InstanceContextManager', count: 1 },
      { callee: 'RLMContextManager.getInstance', count: 1 },
      { callee: 'UnifiedMemoryController.getInstance', count: 1 },
    ]);
  });

  it.each([
    'fixture-readonly-tuple-index.ts',
    'fixture-tuple-binding-defaults.ts',
    'fixture-object-binding-defaults.ts',
    'fixture-binding-default-definite-owner.ts',
    'fixture-tuple-binding-explicit-undefined.ts',
    'fixture-object-binding-explicit-undefined.ts',
    'fixture-binding-void-zero.ts',
    'fixture-binding-possible-undefined-same-owner.ts',
    'fixture-owner-alias-cycles.ts',
  ] as const)('resolves tuple/default/cycle owner values exactly in %s', (fixture) => {
    const program = getSemanticFixtureProgram();
    const source = program.getSourceFile(resolve(mainRoot, 'instance', fixture));
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls(fixture)
      .filter((call) => call.file === `instance/${fixture}`);
    expect(calls.map(({ callee, count }) => ({ callee, count }))).toEqual([
      { callee: 'getRLMContextManager', count: 1 },
      { callee: 'getUnifiedMemory', count: 1 },
      { callee: 'new InstanceContextManager', count: 1 },
      { callee: 'RLMContextManager.getInstance', count: 1 },
      { callee: 'UnifiedMemoryController.getInstance', count: 1 },
    ]);
  });

  it.each([
    'fixture-mixed-alias-cycle.ts',
    'fixture-distinct-owner-alias-cycle.ts',
    'fixture-binding-possible-undefined-mixed.ts',
  ] as const)('fails explicitly for mixed owner identities in %s', (fixture) => {
    const program = getSemanticFixtureProgram();
    const root = resolve(mainRoot, 'instance', fixture);
    const source = program.getSourceFile(root);
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    expect(() => ownerCallsInClosure(program, 'fixture', new Set([root])))
      .toThrow(new RegExp(`Ambiguous owner alias value.*${fixture.replace('.', '\\.')}:`));
  });

  it.each([
    'fixture-binding-default-definite-unrelated.ts',
    'fixture-binding-defined-falsy.ts',
    'fixture-unrelated-alias-cycle.ts',
  ] as const)('keeps proven unrelated tuple/default/cycle values out in %s', (fixture) => {
    const program = getSemanticFixtureProgram();
    const source = program.getSourceFile(resolve(mainRoot, 'instance', fixture));
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls(fixture)
      .filter((call) => call.file === `instance/${fixture}`);
    expect(calls).toEqual([]);
  });

  it('resolves a locally shadowed undefined binding by symbol value', () => {
    const program = getSemanticFixtureProgram();
    const fixture = 'fixture-binding-shadowed-undefined.ts';
    const source = program.getSourceFile(resolve(mainRoot, 'instance', fixture));
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls(fixture)
      .filter((call) => call.file === `instance/${fixture}`);
    expect(calls.map(({ callee, count }) => ({ callee, count }))).toEqual([
      { callee: 'RLMContextManager.getInstance', count: 1 },
    ]);
  });

  it.each([
    'fixture-conditional-ambiguous-rlm-class.ts',
    'fixture-conditional-ambiguous-rlm-helper.ts',
    'fixture-conditional-ambiguous-memory-class.ts',
    'fixture-conditional-ambiguous-memory-helper.ts',
    'fixture-conditional-ambiguous-context.ts',
  ] as const)('fails with a source diagnostic for mixed conditional values in %s', (fixture) => {
    const program = getSemanticFixtureProgram();
    const root = resolve(mainRoot, 'instance', fixture);
    const source = program.getSourceFile(root);
    expect(program.getSemanticDiagnostics(source)).toEqual([]);

    expect(() => ownerCallsInClosure(program, 'fixture', new Set([root])))
      .toThrow(new RegExp(`Ambiguous owner alias value.*${fixture.replace('.', '\\.')}:4:`));
  });

  it('counts same-owner conditional branches once for every owner form', () => {
    const program = getSemanticFixtureProgram();
    const fixture = 'fixture-conditional-same-owner.ts';
    const source = program.getSourceFile(resolve(mainRoot, 'instance', fixture));
    expect(program.getSemanticDiagnostics(source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls(fixture)
      .filter((call) => call.file === `instance/${fixture}`);
    expect(calls.map(({ callee, count }) => ({ callee, count }))).toEqual([
      { callee: 'getRLMContextManager', count: 1 },
      { callee: 'getUnifiedMemory', count: 1 },
      { callee: 'new InstanceContextManager', count: 1 },
      { callee: 'RLMContextManager.getInstance', count: 1 },
      { callee: 'UnifiedMemoryController.getInstance', count: 1 },
    ]);
  });

  it('does not classify unrelated-only conditional branches as owners', () => {
    const program = getSemanticFixtureProgram();
    const fixture = 'fixture-conditional-unrelated.ts';
    const source = program.getSourceFile(resolve(mainRoot, 'instance', fixture));
    expect(program.getSemanticDiagnostics(source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls(fixture)
      .filter((call) => call.file === `instance/${fixture}`);
    expect(calls).toEqual([]);
  });

  it('merges identical owner values assigned by if/else for every owner form', () => {
    const program = getSemanticFixtureProgram();
    const fixture = 'fixture-if-same-owner.ts';
    const source = program.getSourceFile(resolve(mainRoot, 'instance', fixture));
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls(fixture)
      .filter((call) => call.file === `instance/${fixture}`);
    expect(calls.map(({ callee, count }) => ({ callee, count }))).toEqual([
      { callee: 'getRLMContextManager', count: 1 },
      { callee: 'getUnifiedMemory', count: 1 },
      { callee: 'new InstanceContextManager', count: 1 },
      { callee: 'RLMContextManager.getInstance', count: 1 },
      { callee: 'UnifiedMemoryController.getInstance', count: 1 },
    ]);
  });

  it.each([
    'fixture-if-mixed-rlm-class.ts',
    'fixture-if-mixed-rlm-helper.ts',
    'fixture-if-mixed-memory-class.ts',
    'fixture-if-mixed-memory-helper.ts',
    'fixture-if-mixed-context.ts',
  ] as const)('fails with a source diagnostic for mixed if/else values in %s', (fixture) => {
    const program = getSemanticFixtureProgram();
    const root = resolve(mainRoot, 'instance', fixture);
    const source = program.getSourceFile(root);
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    expect(() => ownerCallsInClosure(program, 'fixture', new Set([root])))
      .toThrow(new RegExp(`Ambiguous owner alias value.*${fixture.replace('.', '\\.')}:5:`));
  });

  it('keeps unrelated-only if/else values outside the owner manifest', () => {
    const program = getSemanticFixtureProgram();
    const fixture = 'fixture-if-unrelated.ts';
    const source = program.getSourceFile(resolve(mainRoot, 'instance', fixture));
    expect(semanticDiagnosticMessages(program, source)).toEqual([]);

    const calls = analyzeFixtureOwnerCalls(fixture)
      .filter((call) => call.file === `instance/${fixture}`);
    expect(calls).toEqual([]);
  });

  it('fails explicitly when control flow makes an owner alias value ambiguous', () => {
    const program = getSemanticFixtureProgram();
    const root = resolve(mainRoot, 'instance/fixture-ambiguous-write.ts');
    const source = program.getSourceFile(root);
    expect(program.getSemanticDiagnostics(source)).toEqual([]);

    expect(() => ownerCallsInClosure(program, 'fixture', new Set([root])))
      .toThrow(/Ambiguous owner alias value.*fixture-ambiguous-write\.ts/);
  });

  it('follows runtime re-export chains before resolving aliased owner calls', () => {
    const program = getSemanticFixtureProgram();
    const root = resolve(mainRoot, 'instance/fixture-reexport-entry.ts');
    const closure = [...runtimeClosure(program, root)].map((file) => relative(mainRoot, file));
    const calls = analyzeFixtureOwnerCalls('fixture-reexport-entry.ts')
      .filter((call) => call.file === 'instance/fixture-reexport-entry.ts');

    expect(closure).toContain('instance/fixture-reexport.ts');
    expect(calls).toEqual([
      { role: 'fixture', file: 'instance/fixture-reexport-entry.ts', callee: 'RLMContextManager.getInstance', count: 1 },
    ]);
  });

  it('resolves runtime re-exports, import-equals, dynamic imports, requires, and configured aliases', () => {
    const references = runtimeModuleReferences([
      "export { RLMContextManager as Manager } from '../rlm/context-manager';",
      "export type { RLMContextManager as ManagerType } from '../rlm/context-manager';",
      "import manager = require('../rlm/context-manager');",
      "void import('../memory/unified-controller');",
      "void require('../rlm/context-manager');",
      "import type { ContextStore } from '@shared/types/rlm.types';",
      "import { generateId } from '@shared/utils/id-generator';",
    ].join('\n'));
    const program = getSemanticFixtureProgram();
    const aliasTarget = resolvedRuntimeTarget(
      program,
      resolve(mainRoot, 'instance/fixture-configured-alias.ts'),
      '@shared/utils/id-generator',
    );

    expect(references).toEqual([
      { specifier: '../rlm/context-manager', importedNames: ['RLMContextManager'], kind: 'export' },
      { specifier: '../rlm/context-manager', importedNames: ['manager'], kind: 'import-equals' },
      { specifier: '../memory/unified-controller', importedNames: ['*'], kind: 'dynamic-import' },
      { specifier: '../rlm/context-manager', importedNames: ['*'], kind: 'require' },
      { specifier: '@shared/utils/id-generator', importedNames: ['generateId'], kind: 'import' },
    ]);
    expect(relative(projectRoot, aliasTarget ?? '')).toBe('src/shared/utils/id-generator.ts');
  });

  it('reports stale exact-manifest entries as well as unexpected owner calls', () => {
    const observed = [
      { role: 'context-worker', file: 'instance/context-worker-main.ts', callee: 'getUnifiedMemory', count: 1 },
    ];
    const expected = [
      { role: 'context-worker', file: 'instance/context-worker-main.ts', callee: 'getUnifiedMemory', count: 2 },
      { role: 'context-worker', file: 'instance/stale.ts', callee: 'getRLMContextManager', count: 1 },
    ];

    expect(manifestDifferences(observed, expected)).toEqual([
      '- context-worker instance/context-worker-main.ts getUnifiedMemory x2',
      '- context-worker instance/stale.ts getRLMContextManager x1',
      '+ context-worker instance/context-worker-main.ts getUnifiedMemory x1',
    ]);
  });
});
