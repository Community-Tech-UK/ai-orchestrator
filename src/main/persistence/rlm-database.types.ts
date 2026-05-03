/**
 * Database row types for RLM persistence
 */

export interface ContextStoreRow {
  id: string;
  instance_id: string;
  total_tokens: number;
  total_size: number;
  access_count: number;
  created_at: number;
  last_accessed: number;
  config_json: string | null;
}

export interface ContextSectionRow {
  id: string;
  store_id: string;
  type: string;
  name: string;
  source: string | null;
  start_offset: number;
  end_offset: number;
  tokens: number;
  checksum: string | null;
  depth: number;
  summarizes_json: string | null;
  parent_summary_id: string | null;
  file_path: string | null;
  language: string | null;
  source_url: string | null;
  created_at: number;
  content_file: string | null;
  content_inline: string | null;
}

export interface SearchIndexEntry {
  storeId: string;
  term: string;
  sectionId: string;
  lineNumber: number;
  position: number;
  snippet: string;
}

export interface SearchResultRow {
  section_id: string;
  line_number: number;
  position: number;
  snippet: string;
  section_type: string;
  section_name: string;
  section_source: string | null;
  term_matches: number;
}

export interface SearchResult {
  sectionId: string;
  lineNumber: number;
  position: number;
  snippet: string;
  sectionType: string;
  sectionName: string;
  sectionSource: string | null;
  relevance: number;
}

export interface RLMSessionRow {
  id: string;
  store_id: string;
  instance_id: string;
  started_at: number;
  ended_at: number | null;
  last_activity_at: number;
  total_queries: number;
  total_root_tokens: number;
  total_sub_query_tokens: number;
  estimated_direct_tokens: number;
  token_savings_percent: number;
  queries_json: string | null;
  recursive_calls_json: string | null;
}

export interface OutcomeRow {
  id: string;
  task_type: string;
  success: number;
  timestamp: number;
  duration_ms: number | null;
  token_usage: number | null;
  agent_id: string | null;
  model: string | null;
  error_type: string | null;
  prompt_hash: string | null;
  tools_json: string | null;
  metadata_json: string | null;
}

export interface PatternRow {
  id: string;
  type: string;
  key: string;
  effectiveness: number;
  sample_size: number;
  last_updated: number;
  metadata_json: string | null;
}

export interface ExperienceRow {
  id: string;
  task_type: string;
  success_count: number;
  failure_count: number;
  success_patterns_json: string | null;
  failure_patterns_json: string | null;
  example_prompts_json: string | null;
  last_updated: number;
}

export interface InsightRow {
  id: string;
  type: string;
  title: string;
  description: string | null;
  confidence: number;
  supporting_patterns_json: string | null;
  created_at: number;
  expires_at: number | null;
}

export interface VectorRow {
  id: string;
  store_id: string;
  section_id: string;
  embedding: Buffer;
  dimensions: number;
  content_preview: string | null;
  metadata_json: string | null;
  created_at: number;
}

// Observation types
export interface ObservationRow {
  id: string;
  summary: string;
  source_ids_json: string | null;
  instance_ids_json: string | null;
  themes_json: string | null;
  key_findings_json: string | null;
  success_signals: number;
  failure_signals: number;
  timestamp: number;
  created_at: number;
  ttl: number;
  promoted: number;
  token_count: number;
  embedding_id: string | null;
}

export interface ReflectionRow {
  id: string;
  title: string;
  insight: string;
  observation_ids_json: string | null;
  patterns_json: string | null;
  confidence: number;
  applicability_json: string | null;
  created_at: number;
  ttl: number;
  usage_count: number;
  effectiveness_score: number;
  promoted_to_procedural: number;
  embedding_id: string | null;
}

// Migration types
export interface MigrationRow {
  id: number;
  name: string;
  applied_at: number;
  checksum: string;
}

export interface Migration {
  name: string;
  up: string;
  down?: string;
}

// Knowledge Graph rows
export interface KGEntityRow {
  id: string;
  name: string;
  type: string;
  properties_json: string;
  created_at: number;
}

export interface KGTripleRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  source_closet: string | null;
  source_file: string | null;
  extracted_at: number;
}

export interface CodebaseMiningStatusRow {
  normalized_path: string;
  root_path: string;
  project_key: string;
  display_name: string;
  discovery_source: string;
  auto_mine: number;
  is_paused: number;
  is_excluded: number;
  status: string;
  content_fingerprint: string | null;
  files_json: string;
  facts_extracted: number;
  hints_created: number;
  files_read: number;
  errors_json: string;
  started_at: number | null;
  completed_at: number | null;
  last_active_at: number | null;
  created_at: number;
  updated_at: number;
  metadata_json: string;
}

export interface ProjectKnowledgeSourceRow {
  id: string;
  project_key: string;
  source_kind: string;
  source_uri: string;
  source_title: string | null;
  content_fingerprint: string;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  metadata_json: string;
}

export interface ProjectKnowledgeKgLinkRow {
  id: string;
  project_key: string;
  source_id: string;
  triple_id: string;
  source_span_json: string;
  evidence_strength: number;
  created_at: number;
  metadata_json: string;
}
export interface ProjectKnowledgeWakeLinkRow {
  id: string;
  project_key: string;
  source_id: string;
  hint_id: string;
  source_span_json: string;
  evidence_strength: number;
  created_at: number;
  metadata_json: string;
}

export interface ProjectCodeIndexStatusRow {
  project_key: string;
  workspace_hash: string | null;
  status: string;
  file_count: number;
  symbol_count: number;
  sync_started_at: number | null;
  last_indexed_at: number | null;
  last_synced_at: number | null;
  updated_at: number;
  error: string | null;
  metadata_json: string;
}

export interface ProjectCodeSymbolRow {
  id: string;
  project_key: string;
  source_id: string;
  workspace_hash: string;
  symbol_id: string;
  path_from_root: string;
  name: string;
  kind: string;
  container_name: string | null;
  start_line: number;
  start_character: number;
  end_line: number | null;
  end_character: number | null;
  signature: string | null;
  doc_comment: string | null;
  created_at: number;
  updated_at: number;
  metadata_json: string;
}

// Verbatim segment rows
export interface VerbatimSegmentRow {
  id: string;
  content: string;
  source_file: string;
  chunk_index: number;
  wing: string;
  room: string;
  importance: number;
  added_by: string;
  created_at: number;
}

export interface ConversationImportRow {
  id: string;
  file_path: string;
  format: string;
  wing: string;
  message_count: number;
  segments_created: number;
  status: string;
  error: string | null;
  imported_at: number;
}

// Wake context rows
export interface WakeHintRow {
  id: string;
  content: string;
  importance: number;
  room: string;
  source_reflection_id: string | null;
  source_session_id: string | null;
  created_at: number;
  last_used: number;
  usage_count: number;
}

export interface ProjectMemoryStartupBriefRow {
  id: string;
  instance_id: string;
  project_key: string;
  rendered_text: string;
  sections_json: string;
  sources_json: string;
  max_chars: number;
  rendered_chars: number;
  source_count: number;
  truncated: number;
  provider: string | null;
  model: string | null;
  created_at: number;
  metadata_json: string;
}
