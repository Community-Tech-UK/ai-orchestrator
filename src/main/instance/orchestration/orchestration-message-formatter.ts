export class OrchestrationMessageFormatter {
  format(action: string, status: string, data: Record<string, any>): string {
    switch (action) {
      case 'spawn_child':
        if (status === 'SUCCESS') {
          return `**Child Spawned:** ${data['name'] || 'Child instance'}\n\nID: \`${data['childId']}\``;
        }
        return `**Failed to spawn child:** ${data['error'] || 'Unknown error'}`;
      case 'message_child':
        return status === 'SUCCESS'
          ? `**Message sent** to child \`${data['childId']}\``
          : `**Failed to send message:** ${data['error'] || 'Unknown error'}`;
      case 'terminate_child':
        return status === 'SUCCESS'
          ? `**Child terminated:** \`${data['childId']}\``
          : `**Failed to terminate child:** ${data['error'] || 'Unknown error'}`;
      case 'task_complete':
        return `**Task completed** by child \`${data['childId']}\`\n\n${data['result']?.summary || data['message'] || 'No summary'}`;
      case 'task_progress':
        return `**Progress update** from child \`${data['childId']}\`: ${data['progress']?.percentage || 0}% - ${data['progress']?.currentStep || 'Working...'}`;
      case 'task_error':
        return `**Error** from child \`${data['childId']}\`:\n\n${data['error']?.message || data['message'] || 'Unknown error'}`;
      case 'get_children':
        return this.formatGetChildrenMessage(data);
      case 'get_child_output':
        return this.formatChildOutputMessage(status, data);
      case 'call_tool':
        return this.formatToolCallMessage(status, data);
      case 'consensus_query':
        return this.formatConsensusQueryMessage(status, data);
      case 'child_result':
        return this.formatChildResultMessage(data);
      case 'child_completed':
        return this.formatChildCompletedMessage(data);
      case 'all_children_completed':
        return this.formatAllChildrenCompletedMessage(data);
      case 'get_child_summary':
        return this.formatChildSummaryMessage(status, data);
      case 'get_child_artifacts':
        return this.formatChildArtifactsMessage(status, data);
      case 'get_child_section':
        return this.formatChildSectionMessage(status, data);
      case 'request_user_action':
        return this.formatRequestUserActionMessage(data);
      case 'user_action_response':
        return status === 'SUCCESS'
          ? `**User responded** to "${data['requestType'] || 'request'}" - ${data['approved'] ? 'Approved' : 'Rejected'}${data['selectedOption'] ? `: ${String(data['selectedOption']).slice(0, 200)}` : ''}`
          : '**User action response failed**';
      default:
        return `**Orchestration:** ${action} - ${status}`;
    }
  }

  private formatGetChildrenMessage(data: Record<string, any>): string {
    const activeConsensusQueries = typeof data['activeConsensusQueries'] === 'number'
      ? data['activeConsensusQueries']
      : 0;
    const completedChildIds = Array.isArray(data['completedChildIds'])
      ? data['completedChildIds'] as string[]
      : [];
    if (data['children'] && data['children'].length > 0) {
      const childList = data['children']
        .map((c: any) => `- **${c.name}** (\`${c.id}\`) - ${c.status}`)
        .join('\n');
      const consensusLine = activeConsensusQueries > 0
        ? `\n\n**Consensus queries running:** ${activeConsensusQueries}`
        : '';
      return `**Active children:**\n\n${childList}${consensusLine}`;
    }
    if (activeConsensusQueries > 0) {
      const queryLabel = activeConsensusQueries === 1 ? 'query is' : 'queries are';
      return `**Consensus query in progress**\n\nNo child instances are active. ${activeConsensusQueries} internal consensus ${queryLabel} still running.`;
    }
    if (completedChildIds.length > 0) {
      const shown = completedChildIds.slice(-5);
      const childList = shown.map((id) => `- \`${id}\``).join('\n');
      const extra = completedChildIds.length > shown.length
        ? `\n- ... and ${completedChildIds.length - shown.length} more`
        : '';
      return `**No active children**\n\n${completedChildIds.length} child instance${completedChildIds.length === 1 ? '' : 's'} completed recently:\n${childList}${extra}`;
    }
    return '**No active children**';
  }

  private formatChildOutputMessage(status: string, data: Record<string, any>): string {
    if (status !== 'SUCCESS') {
      const errChildId = data['childId'] ? ` \`${data['childId']}\`` : '';
      return `**Failed to get child output**${errChildId}: ${data['error'] || 'Unknown error'}`;
    }
    if (data['output'] && data['output'].length > 0) {
      return `**Output from child \`${data['childId']}\`:**\n\n\`\`\`\n${data['output'].join('\n')}\n\`\`\``;
    }
    return `**No output from child** \`${data['childId'] ?? '(unknown)'}\``;
  }

  private formatToolCallMessage(status: string, data: Record<string, any>): string {
    if (status === 'SUCCESS') {
      const toolId = data['toolId'] || data['tool']?.id || 'tool';
      const outputPreview =
        data['output'] !== undefined
          ? (typeof data['output'] === 'string'
              ? data['output']
              : JSON.stringify(data['output'], null, 2))
          : '';
      const trimmed =
        outputPreview.length > 1500
          ? outputPreview.slice(0, 1500) + '\n... (truncated)'
          : outputPreview;
      return `**Tool ran:** \`${toolId}\`\n\n\`\`\`\n${trimmed}\n\`\`\``;
    }
    return `**Tool failed:** \`${data['toolId'] || data['tool']?.id || 'tool'}\`\n\n${data['error'] || 'Unknown error'}`;
  }

  private formatConsensusQueryMessage(status: string, data: Record<string, any>): string {
    if (data['status'] === 'dispatching') {
      const requestedProviders = Array.isArray(data['providersRequested']) && data['providersRequested'].length > 0
        ? data['providersRequested'].join(', ')
        : 'available providers';
      return `**Consensus query started**\n\nConsulting ${requestedProviders}.`;
    }

    if (status === 'SUCCESS') {
      const parts: string[] = [];
      parts.push('**Consensus complete**');

      if (typeof data['successCount'] === 'number' || typeof data['failureCount'] === 'number') {
        const successCount = typeof data['successCount'] === 'number' ? data['successCount'] : 0;
        const failureCount = typeof data['failureCount'] === 'number' ? data['failureCount'] : 0;
        parts.push(`${successCount} provider${successCount === 1 ? '' : 's'} responded, ${failureCount} failed.`);
      }

      if (typeof data['totalDurationMs'] === 'number') {
        parts.push(`Duration: ${Math.round(data['totalDurationMs'] / 1000)}s.`);
      }

      parts.push('');
      parts.push('_Result injected to parent CLI._');
      return parts.join('\n');
    }

    const parts = ['**Consensus query failed**'];
    if (data['message'] || data['error']) {
      parts.push('');
      parts.push(String(data['message'] || data['error']));
    }

    if (Array.isArray(data['errors']) && data['errors'].length > 0) {
      parts.push('');
      parts.push('**Provider errors:**');
      for (const err of data['errors'].slice(0, 3)) {
        const provider = typeof err.provider === 'string' ? err.provider : 'provider';
        const message = typeof err.error === 'string' ? err.error : 'unknown error';
        parts.push(`- ${provider}: ${message}`);
      }
      if (data['errors'].length > 3) {
        parts.push(`- ... and ${data['errors'].length - 3} more`);
      }
    }

    return parts.join('\n');
  }

  private formatRequestUserActionMessage(data: Record<string, any>): string {
    const title = data['title'] || 'User Action Required';
    const message = data['message'] || '';
    const questions = data['questions'] as string[] | undefined;

    const parts: string[] = [];
    parts.push(`**Awaiting your response** - ${title}`);

    if (message) {
      parts.push('');
      parts.push(message);
    }

    if (questions && questions.length > 0) {
      parts.push('');
      questions.forEach((q: string, i: number) => {
        parts.push(`${i + 1}. ${q}`);
      });
    }

    parts.push('');
    parts.push('_See the prompt below to respond._');

    return parts.join('\n');
  }

  private formatChildResultMessage(data: Record<string, any>): string {
    const parts: string[] = [];
    parts.push(`**Child Result** from \`${data['childId']}\``);
    parts.push('');
    parts.push(`**Summary:** ${data['summary']}`);
    parts.push(`**Status:** ${data['success'] ? 'Success' : 'Failed'}`);

    if (data['artifactCount'] > 0) {
      parts.push(`**Artifacts:** ${data['artifactCount']} (${data['artifactTypes']?.join(', ') || 'various'})`);
    }

    if (data['conclusions'] && data['conclusions'].length > 0) {
      parts.push('');
      parts.push('**Conclusions:**');
      data['conclusions'].slice(0, 3).forEach((c: string) => parts.push(`- ${c}`));
      if (data['conclusions'].length > 3) {
        parts.push(`- ... and ${data['conclusions'].length - 3} more`);
      }
    }

    if (data['hasMoreDetails']) {
      parts.push('');
      parts.push('_Use `get_child_artifacts` or `get_child_section` for more details._');
    }

    return parts.join('\n');
  }

  private formatChildSummaryMessage(status: string, data: Record<string, any>): string {
    if (status !== 'SUCCESS') {
      return `**Child Summary Error:** ${data['error'] || 'Unknown error'}\n\n${data['suggestion'] || ''}`;
    }

    const parts: string[] = [];
    parts.push(`**Summary for child \`${data['childId']}\`:**`);
    parts.push('');
    parts.push(data['summary']);
    parts.push('');
    parts.push(`**Status:** ${data['success'] ? 'Success' : 'Failed'}`);

    if (data['artifactCount'] > 0) {
      parts.push(`**Artifacts:** ${data['artifactCount']} (${data['artifactTypes']?.join(', ') || 'various'})`);
    }

    if (data['conclusions'] && data['conclusions'].length > 0) {
      parts.push('');
      parts.push('**Conclusions:**');
      data['conclusions'].forEach((c: string) => parts.push(`- ${c}`));
    }

    return parts.join('\n');
  }

  private formatChildArtifactsMessage(status: string, data: Record<string, any>): string {
    if (status !== 'SUCCESS') {
      return `**Artifacts Error:** ${data['error'] || 'Unknown error'}`;
    }

    const parts: string[] = [];
    parts.push(`**Artifacts from child \`${data['childId']}\`** (${data['filtered']}/${data['total']})`);

    if (data['artifacts'] && data['artifacts'].length > 0) {
      for (const artifact of data['artifacts']) {
        parts.push('');
        const severity = artifact.severity ? `[${artifact.severity.toUpperCase()}]` : '';
        parts.push(`### ${severity} ${artifact.title || artifact.type}`);
        if (artifact.file) {
          const location = artifact.lines ? `${artifact.file}:${artifact.lines}` : artifact.file;
          parts.push(`**Location:** \`${location}\``);
        }
        parts.push(artifact.content);
      }
    } else {
      parts.push('_No artifacts found._');
    }

    if (data['hasMore']) {
      parts.push('');
      parts.push(`_${data['total'] - data['filtered']} more artifacts available. Use limit parameter to fetch more._`);
    }

    return parts.join('\n');
  }

  private formatChildSectionMessage(status: string, data: Record<string, any>): string {
    if (status !== 'SUCCESS') {
      return `**Section Error:** ${data['error'] || 'Unknown error'}`;
    }

    const parts: string[] = [];
    parts.push(`**${data['section']}** from child \`${data['childId']}\` (${data['tokenCount']} tokens)`);

    if (data['warning']) {
      parts.push('');
      parts.push(`⚠️ ${data['warning']}`);
    }

    parts.push('');
    parts.push(data['content']);

    return parts.join('\n');
  }

  private formatChildCompletedMessage(data: Record<string, any>): string {
    const parts: string[] = [];
    const name = data['name'] || data['childId'] || 'Unknown child';
    const statusLabel = data['success'] ? 'Success' : 'Failed';
    parts.push(`**Child Completed:** ${name} (\`${data['childId']}\`)`);
    parts.push(`**Status:** ${statusLabel}`);
    if (data['summary']) {
      parts.push('');
      parts.push(data['summary']);
    }
    const conclusions = data['conclusions'] as string[] | undefined;
    if (conclusions && conclusions.length > 0) {
      parts.push('');
      parts.push('**Conclusions:**');
      for (const c of conclusions) {
        parts.push(`- ${c}`);
      }
    }
    return parts.join('\n');
  }

  private formatAllChildrenCompletedMessage(data: Record<string, any>): string {
    const parts: string[] = [];
    parts.push(`**All ${data['totalChildren']} children completed**`);
    parts.push('');
    const summaries = data['summaries'] as { success: boolean; name: string; summary: string }[] | undefined;
    if (summaries && summaries.length > 0) {
      for (const s of summaries) {
        const statusLabel = s.success ? 'SUCCESS' : 'FAILED';
        parts.push(`- **[${statusLabel}]** ${s.name}: ${s.summary}`);
      }
    }
    parts.push('');
    parts.push('_Synthesis prompt injected to parent CLI._');
    return parts.join('\n');
  }
}
