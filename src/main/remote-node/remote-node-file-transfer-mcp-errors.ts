export class NodeFileTransferMcpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly suggestion?: string,
  ) {
    super(suggestion ? `${code}: ${message}. ${suggestion}` : `${code}: ${message}`);
    this.name = 'NodeFileTransferMcpError';
  }
}
