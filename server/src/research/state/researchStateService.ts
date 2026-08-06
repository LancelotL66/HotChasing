import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { researchStateSchema, type ResearchState, type ValueSource } from './researchStateSchema.js';

/**
 * Research State 的持久化与版本管理。
 * 每次实质修改都写入新版本；历史版本不可覆盖，保证测试报告可复现。
 */

export interface ResearchStateVersionRow {
  id: string;
  topic_id: string;
  version: number;
  parent_version: number | null;
  state_json: string;
  change_proposal_id: string | null;
  change_summary: string | null;
  created_by: string;
  created_at: string;
}

export interface ResearchStateVersionView {
  version: number;
  parentVersion: number | null;
  changeProposalId: string | null;
  changeSummary: string | null;
  createdBy: string;
  createdAt: string;
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function getStateVersion(topicId: string, version: number): ResearchState | null {
  const row = getDb()
    .prepare('SELECT state_json FROM research_state_versions WHERE topic_id=? AND version=?')
    .get(topicId, version) as { state_json?: string } | undefined;
  if (!row?.state_json) return null;
  return researchStateSchema.parse(JSON.parse(row.state_json));
}

export function getCurrentState(topicId: string): ResearchState | null {
  const topic = getDb()
    .prepare('SELECT current_state_version FROM research_topics WHERE id=?')
    .get(topicId) as { current_state_version?: number } | undefined;
  if (!topic) return null;
  return getStateVersion(topicId, Number(topic.current_state_version ?? 1));
}

export function requireCurrentState(topicId: string): ResearchState {
  const state = getCurrentState(topicId);
  if (!state) throw codedError('RESEARCH_STATE_NOT_FOUND', '未找到当前研究状态');
  return state;
}

export function listVersions(topicId: string): ResearchStateVersionView[] {
  const rows = getDb()
    .prepare('SELECT version, parent_version, change_proposal_id, change_summary, created_by, created_at FROM research_state_versions WHERE topic_id=? ORDER BY version DESC')
    .all(topicId) as Array<Omit<ResearchStateVersionRow, 'id' | 'topic_id' | 'state_json'>>;
  return rows.map((row) => ({
    version: Number(row.version),
    parentVersion: row.parent_version === null || row.parent_version === undefined ? null : Number(row.parent_version),
    changeProposalId: row.change_proposal_id ?? null,
    changeSummary: row.change_summary ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

export interface SaveStateOptions {
  changeProposalId?: string | null;
  changeSummary?: string | null;
  createdBy?: ValueSource | 'SYSTEM';
  parentVersion?: number | null;
}

/**
 * 写入新版本并把主题的 current_state_version 指向它。
 * 传入的 state.version 会被忽略，版本号由后端单调递增分配。
 */
export function saveNewVersion(topicId: string, next: ResearchState, options: SaveStateOptions = {}): ResearchState {
  const db = getDb();
  const latest = db
    .prepare('SELECT MAX(version) as version FROM research_state_versions WHERE topic_id=?')
    .get(topicId) as { version?: number | null } | undefined;
  const parentVersion = options.parentVersion ?? (latest?.version ?? null);
  const version = Number(latest?.version ?? 0) + 1;
  const state = researchStateSchema.parse({ ...next, topicId, version, updatedAt: new Date().toISOString() });
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO research_state_versions (id, topic_id, version, parent_version, state_json, change_proposal_id, change_summary, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(
    randomUUID(),
    topicId,
    version,
    parentVersion,
    JSON.stringify(state),
    options.changeProposalId ?? null,
    options.changeSummary ?? null,
    options.createdBy ?? 'SYSTEM',
    now,
  );
  db.prepare('UPDATE research_topics SET current_state_version=?, updated_at=? WHERE id=?').run(version, now, topicId);
  return state;
}

export interface StateDiff {
  field: string;
  from: string;
  to: string;
}

/** 版本 Diff：只比较用户关心的结构字段，不做逐字符文本 diff。 */
export function diffStates(from: ResearchState, to: ResearchState): StateDiff[] {
  const diffs: StateDiff[] = [];
  const push = (field: string, a: unknown, b: unknown) => {
    const left = typeof a === 'string' ? a : JSON.stringify(a);
    const right = typeof b === 'string' ? b : JSON.stringify(b);
    if (left !== right) diffs.push({ field, from: left ?? '', to: right ?? '' });
  };
  push('title', from.title, to.title);
  push('objective', from.objective, to.objective);
  for (const key of Object.keys(to.requirements) as Array<keyof ResearchState['requirements']>) {
    push(`requirements.${key}`, from.requirements[key], to.requirements[key]);
  }
  const fromStages = new Map(from.stages.map((stage) => [stage.id, stage]));
  const toStages = new Map(to.stages.map((stage) => [stage.id, stage]));
  for (const [id, stage] of toStages) {
    const previous = fromStages.get(id);
    if (!previous) { diffs.push({ field: `stage:${id}`, from: '（不存在）', to: `新增「${stage.name}」` }); continue; }
    push(`stage:${id}.name`, previous.name, stage.name);
    push(`stage:${id}.required`, previous.required, stage.required);
    push(`stage:${id}.position`, previous.position, stage.position);
  }
  for (const [id, stage] of fromStages) {
    if (!toStages.has(id)) diffs.push({ field: `stage:${id}`, from: `「${stage.name}」`, to: '（已删除）' });
  }
  const fromTools = new Map(from.selectedTools.map((tool) => [tool.githubNodeId, tool]));
  const toTools = new Map(to.selectedTools.map((tool) => [tool.githubNodeId, tool]));
  for (const [id, tool] of toTools) {
    const previous = fromTools.get(id);
    if (!previous) { diffs.push({ field: `tool:${id}`, from: '（未选择）', to: `${tool.fullName} / ${tool.selectionRole}` }); continue; }
    push(`tool:${id}.selectionRole`, previous.selectionRole, tool.selectionRole);
    push(`tool:${id}.stageId`, previous.stageId, tool.stageId);
    push(`tool:${id}.status`, previous.status, tool.status);
  }
  for (const [id, tool] of fromTools) {
    if (!toTools.has(id)) diffs.push({ field: `tool:${id}`, from: tool.fullName, to: '（已移除）' });
  }
  push('workflow.version', from.workflow?.version ?? null, to.workflow?.version ?? null);
  push('workflow.stageCount', from.workflow?.stages.length ?? 0, to.workflow?.stages.length ?? 0);
  return diffs;
}

/** 恢复历史版本：不覆盖历史，而是把历史内容作为新版本写入。 */
export function restoreVersion(topicId: string, version: number): ResearchState {
  const state = getStateVersion(topicId, version);
  if (!state) throw codedError('RESEARCH_VERSION_NOT_FOUND', `研究状态版本 ${version} 不存在`);
  return saveNewVersion(topicId, state, {
    changeSummary: `恢复到版本 v${version}`,
    createdBy: 'USER_CONFIRMED',
  });
}
