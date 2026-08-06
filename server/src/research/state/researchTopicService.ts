import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import {
  researchStageSchema,
  researchStateSchema,
  type ResearchState,
  type TopicStatus,
} from './researchStateSchema.js';
import { getCurrentState, saveNewVersion } from './researchStateService.js';
import { parseInitialRequirement } from '../conversation/researchInitialParser.js';
import { validateResearchState } from './researchConsistencyValidator.js';
import { buildToolFacts } from '../analysis/researchToolFacts.js';

/**
 * 研究主题 CRUD 与初始解析。
 * 主题研究是独立业务域：这里不引用 dailyDigestService / top100Service / trendScoreService /
 * digestClassificationService，也不读取 repositories 表的热点或排名字段。
 */

export interface ResearchTopicRow {
  id: string;
  title: string;
  original_requirement: string;
  status: string;
  current_state_version: number;
  created_at: string;
  updated_at: string;
}

export interface ResearchTopicView extends ResearchTopicRow {
  state: ResearchState | null;
  consistency: ReturnType<typeof validateResearchState> | null;
  stageCount: number;
  selectedToolCount: number;
  hasWorkflow: boolean;
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function getTopicRow(id: string): ResearchTopicRow | undefined {
  return getDb().prepare('SELECT * FROM research_topics WHERE id=?').get(id) as ResearchTopicRow | undefined;
}

export function requireTopicRow(id: string): ResearchTopicRow {
  const row = getTopicRow(id);
  if (!row) throw codedError('RESEARCH_TOPIC_NOT_FOUND', '研究主题不存在');
  return row;
}

export function setTopicStatus(id: string, status: TopicStatus): void {
  getDb().prepare('UPDATE research_topics SET status=?, updated_at=? WHERE id=?').run(status, new Date().toISOString(), id);
}

export function toTopicView(row: ResearchTopicRow): ResearchTopicView {
  const state = getCurrentState(row.id);
  return {
    ...row,
    state,
    consistency: state ? validateResearchState(state, buildToolFacts(row.id)) : null,
    stageCount: state?.stages.length ?? 0,
    selectedToolCount: state?.selectedTools.filter((tool) => tool.status !== 'REMOVED_BY_USER').length ?? 0,
    hasWorkflow: Boolean(state?.workflow),
  };
}

export function requireTopic(id: string): ResearchTopicView {
  return toTopicView(requireTopicRow(id));
}

export function listTopics(): ResearchTopicView[] {
  const rows = getDb().prepare('SELECT * FROM research_topics ORDER BY updated_at DESC').all() as ResearchTopicRow[];
  return rows.map(toTopicView);
}

/**
 * 创建研究主题：立即保存用户原始输入并写入 v1 状态。
 * AI 解析是独立步骤（POST /parse），保证 AI 不可用时主题仍然可用。
 */
export function createTopic(requirement: string, title?: string): ResearchTopicView {
  const trimmed = requirement.trim();
  if (!trimmed) throw codedError('INVALID_REQUIREMENT', '研究需求不能为空');
  const id = `topic-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const resolvedTitle = (title?.trim() || trimmed.split(/\r?\n/)[0] || '研究主题').slice(0, 60);
  const db = getDb();
  db.prepare('INSERT INTO research_topics (id, title, original_requirement, status, current_state_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, resolvedTitle, trimmed, 'DRAFT', 1, now, now);
  const initialState = researchStateSchema.parse({
    topicId: id,
    version: 1,
    title: resolvedTitle,
    objective: '',
    originalRequirement: trimmed,
    fieldSources: { title: 'USER_INPUT', originalRequirement: 'USER_INPUT' },
    consistencyStatus: 'NEEDS_RESEARCH_UPDATE',
  });
  saveNewVersion(id, initialState, { changeSummary: '创建研究主题并保存原始需求', createdBy: 'USER_INPUT', parentVersion: null });
  return requireTopic(id);
}

export function updateTopic(id: string, patch: { title?: string; status?: TopicStatus }): ResearchTopicView {
  requireTopicRow(id);
  const now = new Date().toISOString();
  if (patch.title !== undefined) {
    getDb().prepare('UPDATE research_topics SET title=?, updated_at=? WHERE id=?').run(patch.title.slice(0, 60), now, id);
    const state = getCurrentState(id);
    if (state && state.locks.title !== true) {
      saveNewVersion(id, { ...state, title: patch.title.slice(0, 60) }, { changeSummary: '修改主题名称', createdBy: 'USER_MANUAL_EDIT' });
    }
  }
  if (patch.status !== undefined) setTopicStatus(id, patch.status);
  return requireTopic(id);
}

export function deleteTopic(id: string): void {
  requireTopicRow(id);
  const db = getDb();
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM research_tool_candidates WHERE topic_id=?').run(id);
    db.prepare('DELETE FROM research_topic_tools WHERE topic_id=?').run(id);
    const runs = db.prepare('SELECT id FROM research_github_search_runs WHERE topic_id=?').all(id) as Array<{ id: string }>;
    for (const run of runs) db.prepare('DELETE FROM research_github_search_queries WHERE search_run_id=?').run(run.id);
    db.prepare('DELETE FROM research_github_search_runs WHERE topic_id=?').run(id);
    db.prepare('DELETE FROM research_change_proposals WHERE topic_id=?').run(id);
    db.prepare('DELETE FROM research_state_versions WHERE topic_id=?').run(id);
    db.prepare('DELETE FROM research_topics WHERE id=?').run(id);
  });
  remove();
}

/**
 * AI 初始解析：把原始需求解析为结构化需求与研究环节，写入新状态版本。
 * 已锁定的字段不会被解析结果覆盖。
 */
export async function parseTopic(id: string): Promise<{ topic: ResearchTopicView; source: 'ai' | 'rule' }> {
  const row = requireTopicRow(id);
  const current = getCurrentState(id);
  if (!current) throw codedError('RESEARCH_STATE_NOT_FOUND', '未找到当前研究状态');
  setTopicStatus(id, 'PARSING');
  try {
    const { result, source } = await parseInitialRequirement(row.original_requirement);
    const stages = result.stages.map((stage, index) => researchStageSchema.parse({
      id: stage.id,
      name: stage.name,
      description: stage.description,
      position: index,
      required: stage.required,
      source: source === 'ai' ? 'AI_GENERATED' : 'AI_GENERATED',
      inputs: stage.inputs,
      outputs: stage.outputs,
      toolRequirements: {
        languages: result.requirements.languages,
        localDeploymentPreferred: result.requirements.localDeploymentPreferred,
        gpuAllowed: result.requirements.gpuAllowed,
        keywords: stage.keywords,
      },
    }));
    // 用户锁定优先于 AI 建议。
    const lockedStageIds = new Set(current.stages.filter((stage) => stage.locked || current.locks[`stage:${stage.id}`]).map((stage) => stage.id));
    const preservedStages = current.stages.filter((stage) => lockedStageIds.has(stage.id));
    const mergedStages = [...preservedStages, ...stages.filter((stage) => !lockedStageIds.has(stage.id))]
      .map((stage, index) => ({ ...stage, position: index }));
    const next = researchStateSchema.parse({
      ...current,
      title: current.locks.title ? current.title : result.title || current.title,
      objective: current.locks.objective ? current.objective : result.objective,
      requirements: {
        ...current.requirements,
        ...Object.fromEntries(
          Object.entries(result.requirements).filter(([key]) => current.locks[`requirements.${key}`] !== true),
        ),
      },
      stages: mergedStages,
      assumptions: result.assumptions,
      unresolvedIssues: result.unresolvedIssues,
      consistencyStatus: 'NEEDS_PARTIAL_SEARCH',
      fieldSources: {
        ...current.fieldSources,
        objective: current.locks.objective ? current.fieldSources.objective ?? 'USER_INPUT' : source === 'ai' ? 'AI_INFERRED' : 'SYSTEM_DEFAULT',
      },
    });
    saveNewVersion(id, next, {
      changeSummary: source === 'ai' ? 'AI 解析研究需求并生成研究环节' : '规则解析研究需求并生成研究环节',
      createdBy: source === 'ai' ? 'AI_INFERRED' : 'SYSTEM_DEFAULT',
    });
    getDb().prepare('UPDATE research_topics SET title=?, updated_at=? WHERE id=?').run(next.title, new Date().toISOString(), id);
    setTopicStatus(id, 'READY');
    return { topic: requireTopic(id), source };
  } catch (error) {
    setTopicStatus(id, 'DRAFT');
    throw error;
  }
}
