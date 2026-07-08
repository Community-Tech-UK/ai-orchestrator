import {
  CollectBrowserDownloadArgsSchema,
  DownloadFromNodeArgsSchema,
  FindNodeFilesArgsSchema,
  GetNodeFileInfoArgsSchema,
  ListNodeFilesArgsSchema,
  UploadToNodeArgsSchema,
} from './orchestrator-tools';

export const FILE_TRANSFER_TOOL_NAMES = [
  'list_node_files',
  'find_node_files',
  'get_node_file_info',
  'download_from_node',
  'upload_to_node',
  'collect_browser_download',
] as const;

export const FILE_TRANSFER_RPC_SPECS = [
  {
    method: 'orchestrator_tools.list_node_files',
    toolName: 'list_node_files',
    schema: ListNodeFilesArgsSchema,
  },
  {
    method: 'orchestrator_tools.find_node_files',
    toolName: 'find_node_files',
    schema: FindNodeFilesArgsSchema,
  },
  {
    method: 'orchestrator_tools.get_node_file_info',
    toolName: 'get_node_file_info',
    schema: GetNodeFileInfoArgsSchema,
  },
  {
    method: 'orchestrator_tools.download_from_node',
    toolName: 'download_from_node',
    schema: DownloadFromNodeArgsSchema,
  },
  {
    method: 'orchestrator_tools.upload_to_node',
    toolName: 'upload_to_node',
    schema: UploadToNodeArgsSchema,
  },
  {
    method: 'orchestrator_tools.collect_browser_download',
    toolName: 'collect_browser_download',
    schema: CollectBrowserDownloadArgsSchema,
  },
] as const;
