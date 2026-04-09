import z from 'zod';

/**
 * Shared tool safety metadata used by the scheduler.
 */
export interface ToolSafetyMetadata {
  isConcurrencySafe: boolean;
  isReadOnly: boolean;
  isDestructive: boolean;
  estimatedDurationMs?: number;
}

export interface ToolContext {
  instanceId: string;
  workingDirectory: string;
}

export interface ToolModule {
  description: string;
  args?: z.ZodRawShape | z.ZodTypeAny;
  concurrencySafe?: boolean;
  safety?: ToolSafetyMetadata;
  execute: (args: unknown, ctx: ToolContext) => unknown | Promise<unknown>;
}

const DEFAULT_SAFETY: ToolSafetyMetadata = {
  isConcurrencySafe: true,
  isReadOnly: false,
  isDestructive: false,
};

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly id?: string;
  readonly description: string;
  readonly schema: TSchema;
  readonly safety: ToolSafetyMetadata;
  readonly __isToolDefinition: true;
  execute(args: z.infer<TSchema>, ctx: ToolContext): unknown | Promise<unknown>;
}

export interface ToolDefinitionConfig<TSchema extends z.ZodTypeAny> {
  id?: string;
  description: string;
  args: TSchema;
  safety?: ToolSafetyMetadata;
  execute: (
    args: z.infer<TSchema>,
    ctx: ToolContext,
  ) => unknown | Promise<unknown>;
}

export function defineTool<TSchema extends z.ZodTypeAny>(
  config: ToolDefinitionConfig<TSchema>,
): ToolDefinition<TSchema> {
  return {
    id: config.id,
    description: config.description,
    schema: config.args,
    safety: config.safety ?? { ...DEFAULT_SAFETY },
    execute: config.execute,
    __isToolDefinition: true,
  };
}

export function isToolDefinition(value: unknown): value is ToolDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['__isToolDefinition'] === true
  );
}
