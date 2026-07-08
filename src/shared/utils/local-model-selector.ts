import type {
  LocalModelEndpointProvider,
  LocalModelSource,
} from '../types/local-model-runtime.types';

export interface DecodedLocalModelSelector {
  source: LocalModelSource;
  nodeId?: string;
  endpointProvider: LocalModelEndpointProvider;
  endpointId: string;
  modelId: string;
}

export function encodeLocalModelSelector(input: DecodedLocalModelSelector): string {
  const parts = input.source === 'worker-node'
    ? [
        'lm:',
        '',
        'worker-node',
        encode(input.nodeId ?? ''),
        input.endpointProvider,
        encode(input.endpointId),
        encode(input.modelId),
      ]
    : [
        'lm:',
        '',
        'this-device',
        input.endpointProvider,
        encode(input.endpointId),
        encode(input.modelId),
      ];
  return parts.join('/');
}

export function decodeLocalModelSelector(value: string): DecodedLocalModelSelector {
  const parts = value.split('/');
  if (parts[0] !== 'lm:' || parts[1] !== '') {
    throw new Error('Invalid local model selector');
  }
  if (parts[2] === 'worker-node' && parts.length === 7) {
    return {
      source: 'worker-node',
      nodeId: decode(parts[3]),
      endpointProvider: parseEndpointProvider(parts[4]),
      endpointId: decode(parts[5]),
      modelId: decode(parts[6]),
    };
  }
  if (parts[2] === 'this-device' && parts.length === 6) {
    return {
      source: 'this-device',
      endpointProvider: parseEndpointProvider(parts[3]),
      endpointId: decode(parts[4]),
      modelId: decode(parts[5]),
    };
  }
  throw new Error('Invalid local model selector');
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function decode(value: string): string {
  return decodeURIComponent(value);
}

function parseEndpointProvider(value: string): LocalModelEndpointProvider {
  if (value === 'ollama' || value === 'openai-compatible') return value;
  throw new Error('Invalid local model selector');
}
