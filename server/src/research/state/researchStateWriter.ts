import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import type { ChangeOperation } from './researchOperations.js';
import { applyOperations } from './researchStateReducer.js';
import { validateResearchState, type ConsistencyResult } from './researchConsistencyValidator.js';
import { requireCurrentState, saveNewVersion } from './researchStateService.js';
import { buildToolFacts } from '../analysis/researchToolFacts.js';
import type { ResearchState, ValueSource } from './researchStateSchema.js';

/**
 * 唯一的“应用变更”入口：手动编辑与已确认的 AI 提案都走这里。
 * 步骤：reducer → 一致性校验 → 写入新版本 → 同步派生表。
 */

export interface ApplyResult {
  state: ResearchState;
  consistency: ConsistencyResult;
  warnings: string[];
  rejectedOperations: Array<{ type: string; reason: string }>;
}

/** 把 state.selectedTools 同步到查询用的派生表，保持单一事实来源在 state。 */
export function syncTopicTools(state: ResearchState): void {
  const db = getDb();
  const sync = db.transaction(() => {
    db.prepare('DELETE FROM research_topic_tools WHERE topic_id=?').run(state.topicId);
    for (const tool of state.selectedTools) {
      db.prepare(
        `INSERT INTO research_topic_tools
           (id, topic_id, research_state_version, github_node_id, full_name, stage_id, role, selection_role, status, acquisition_mode, notes, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        randomUUID(), state.topicId, state.version, tool.githubNodeId, tool.fullName, tool.stageId || '',
        tool.role, tool.selectionRole, tool.status, tool.acquisitionMode, tool.notes, new Date().toISOString(),
      );
      db.prepare('UPDATE research_tool_candidates SET selection_status=? WHERE topic_id=? AND github_node_id=?')
        .run(tool.status === 'REMOVED_BY_USER' ? 'EXCLUDED' : 'SELECTED', state.topicId, tool.githubNodeId);
    }
  });
  sync();
}

export function applyAndSave(
  topicId: string,
  operations: ChangeOperation[],
  options: { actor?: Extract<ValueSource, 'USER_CONFIRMED' | 'USER_MANUAL_EDIT' | 'AI_PROPOSED'>; summary: string; proposalId?: string | null },
): ApplyResult {
  const current = requireCurrentState(topicId);
  const reduced = applyOperations(current, operations, options.actor ?? 'USER_MANUAL_EDIT');
  const consistency = validateResearchState(reduced.state, buildToolFacts(topicId));
  const state = saveNewVersion(topicId, { ...reduced.state, consistencyStatus: consistency.status }, {
    changeSummary: options.summary,
    changeProposalId: options.proposalId ?? null,
    createdBy: options.actor ?? 'USER_MANUAL_EDIT',
  });
  syncTopicTools(state);
  return { state, consistency, warnings: reduced.warnings, rejectedOperations: reduced.rejectedOperations };
}
