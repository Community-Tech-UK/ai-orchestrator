import { truncateToolOutput, type TruncationOptions } from '../util/tool-output-truncation';

export type ToolOutputKind = 'empty' | 'text' | 'structured';
export type ToolExecutionStatus = 'success' | 'error';

export interface ToolOutputMetadata {
  kind: ToolOutputKind;
  truncated: boolean;
  outputPath?: string;
  byteCount: number;
  lineCount: number;
}

export interface ToolResultTelemetry {
  status: ToolExecutionStatus;
  outputKind: ToolOutputKind;
  truncated: boolean;
  byteCount: number;
  lineCount: number;
}

export interface NormalizedToolResultPayload {
  output: unknown;
  outputMetadata: ToolOutputMetadata;
  telemetry: ToolResultTelemetry;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : (text.match(/\n/g) ?? []).length + 1;
}

export function normalizeToolResultPayload(
  output: unknown,
  status: ToolExecutionStatus,
  options?: Partial<TruncationOptions>,
): NormalizedToolResultPayload {
  if (output === undefined || output === null) {
    const outputMetadata: ToolOutputMetadata = {
      kind: 'empty',
      truncated: false,
      byteCount: 0,
      lineCount: 0,
    };
    return {
      output,
      outputMetadata,
      telemetry: {
        status,
        outputKind: outputMetadata.kind,
        truncated: outputMetadata.truncated,
        byteCount: outputMetadata.byteCount,
        lineCount: outputMetadata.lineCount,
      },
    };
  }

  if (typeof output === 'string' || Buffer.isBuffer(output)) {
    const text = typeof output === 'string' ? output : output.toString('utf8');
    const truncated = truncateToolOutput(text, options);
    const outputMetadata: ToolOutputMetadata = {
      kind: 'text',
      truncated: truncated.truncated,
      outputPath: truncated.truncated ? truncated.outputPath : undefined,
      byteCount: Buffer.byteLength(text),
      lineCount: countLines(text),
    };
    return {
      output: truncated.content,
      outputMetadata,
      telemetry: {
        status,
        outputKind: outputMetadata.kind,
        truncated: outputMetadata.truncated,
        byteCount: outputMetadata.byteCount,
        lineCount: outputMetadata.lineCount,
      },
    };
  }

  let byteCount = 0;
  try {
    byteCount = Buffer.byteLength(JSON.stringify(output));
  } catch {
    byteCount = 0;
  }

  const outputMetadata: ToolOutputMetadata = {
    kind: 'structured',
    truncated: false,
    byteCount,
    lineCount: 0,
  };
  return {
    output,
    outputMetadata,
    telemetry: {
      status,
      outputKind: outputMetadata.kind,
      truncated: outputMetadata.truncated,
      byteCount: outputMetadata.byteCount,
      lineCount: outputMetadata.lineCount,
    },
  };
}
