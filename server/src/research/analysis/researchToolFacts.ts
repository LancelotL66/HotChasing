import { getDb } from '../../db/connection.js';
import type { ToolFacts } from '../state/researchConsistencyValidator.js';
import { toolAnalysisSchema, type ToolAnalysis } from '../state/researchStateSchema.js';

/**
 * 从候选分析缓存中提取一致性校验所需的客观事实。
 * 没有分析结果时返回空事实，validator 会跳过对应约束检查而不是猜测。
 */
export function buildToolFacts(topicId: string): ToolFacts {
  const rows = getDb()
    .prepare(
      `SELECT c.github_node_id AS node_id, c.ai_explanation_json AS analysis, r.primary_language AS language
       FROM research_tool_candidates c
       LEFT JOIN github_repository_cache r ON r.github_node_id = c.github_node_id
       WHERE c.topic_id=?`,
    )
    .all(topicId) as Array<{ node_id: string; analysis: string | null; language: string | null }>;
  const facts: ToolFacts = {};
  for (const row of rows) {
    let analysis: ToolAnalysis | null = null;
    if (row.analysis) {
      const parsed = toolAnalysisSchema.safeParse(safeJson(row.analysis));
      analysis = parsed.success ? parsed.data : null;
    }
    facts[row.node_id] = {
      language: row.language ?? null,
      gpuRequired: analysis?.deployment.gpuRequired ?? false,
      paidApiRequired: analysis?.deployment.paidApiRequired ?? false,
      localSupported: analysis?.deployment.localSupported ?? true,
      roles: analysis?.roles ?? [],
    };
  }
  return facts;
}

export function getToolAnalysis(topicId: string, githubNodeId: string): ToolAnalysis | null {
  const row = getDb()
    .prepare('SELECT ai_explanation_json FROM research_tool_candidates WHERE topic_id=? AND github_node_id=?')
    .get(topicId, githubNodeId) as { ai_explanation_json?: string | null } | undefined;
  if (!row?.ai_explanation_json) return null;
  const parsed = toolAnalysisSchema.safeParse(safeJson(row.ai_explanation_json));
  return parsed.success ? parsed.data : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
