export interface CodememPosition {
  line: number;
  character: number;
}

export interface CodememRange {
  start: CodememPosition;
  end: CodememPosition;
}

export interface CodememLocation {
  uri: string;
  range: CodememRange;
}

export interface CodememSymbolMatch {
  symbolId: string;
  path: string;
  name: string;
  kind: string;
  containerName: string | null;
  range: CodememRange;
  signature: string | null;
  docComment: string | null;
}

export interface CodememReferenceMatch {
  path: string;
  range: CodememRange;
  snippet: string;
}

export interface CodememCallHierarchyNode {
  symbolId: string;
  path: string;
  name: string;
  kind: string;
  containerName: string | null;
  range: CodememRange;
  children: CodememCallHierarchyNode[];
}

export interface CodememDiagnosticsPage {
  items: {
    range: CodememRange;
    severity: string;
    code?: string | number;
    source?: string;
    message: string;
  }[];
  page: number;
  pageSize: number;
  total: number;
}

export type CodememResultStatus = 'ok' | 'warming' | 'lsp_unavailable' | 'symbol_not_found';

export interface CodememResult<T> {
  status: CodememResultStatus;
  data?: T;
  etaMs?: number;
  message?: string;
}
