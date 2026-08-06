import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { requireCurrentState } from '../state/researchStateService.js';
import { activeSelectedTools } from '../theme/themePlanHelpers.js';
import type { ThemeWorkflow } from '../state/researchStateSchema.js';

/**
 * 主题方案命名与版本。
 *
 * 规则（方案第 21、22 节）：
 * - 每次实质修改生成新版本；已锁定版本不可覆盖；
 * - 测试任务绑定具体版本；每个工具固定 Commit / Release / 包版本；
 * - 保存到 Fork 实验室的数据结构不传递任何日报、Top100 或热点字段。
 */

export interface SaveThemePlanOptions {
  name: string;
  description?: string;
  testGoal?: string;
  allowAgentModification?: boolean;
  shouldCreateFork?: boolean;
  retainEnvironment?: boolean;
}

export interface ThemePlanView {
  id: string;
  name: string;
  description: string | null;
  researchTopicId: string | null;
  status: string;
  localStatus: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

function toThemeView(row: Record<string, unknown>): ThemePlanView {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    researchTopicId: row.research_topic_id === null || row.research_topic_id === undefined ? null : String(row.research_topic_id),
    status: String(row.status ?? 'DRAFT'),
    localStatus: String(row.local_status ?? 'NOT_STARTED'),
    currentVersion: Number(row.current_version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export interface ThemeVersionView {
  id: string;
  themeId: string;
  version: number;
  researchStateVersion: number;
  objective: string;
  planJson: Record<string, unknown>;
  locked: boolean;
  createdAt: string;
  tools: Array<{
    githubNodeId: string;
    fullName: string;
    role: string;
    acquisitionMode: string;
    position: number;
    config: Record<string, unknown> | null;
  }>;
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function listThemes(): ThemePlanView[] {
  const rows = getDb().prepare('SELECT * FROM fork_lab_themes ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map(toThemeView);
}

export function getTheme(themeId: string): ThemePlanView | null {
  const row = getDb().prepare('SELECT * FROM fork_lab_themes WHERE id=?').get(themeId) as Record<string, unknown> | undefined;
  return row ? toThemeView(row) : null;
}

export function requireTheme(themeId: string): ThemePlanView {
  const theme = getTheme(themeId);
  if (!theme) throw codedError('THEME_NOT_FOUND', '主题方案不存在');
  return theme;
}

export function listThemeVersions(themeId: string): ThemeVersionView[] {
  requireTheme(themeId);
  const rows = getDb()
    .prepare('SELECT * FROM fork_lab_theme_versions WHERE theme_id=? ORDER BY version DESC')
    .all(themeId) as Array<Record<string, unknown>>;
  return rows.map(rowToVersionView);
}

function rowToVersionView(row: Record<string, unknown>): ThemeVersionView {
  const tools = getDb()
    .prepare('SELECT * FROM fork_lab_theme_tools WHERE theme_version_id=? ORDER BY position ASC')
    .all(row.id as string) as Array<{ github_node_id: string; full_name: string; role: string; acquisition_mode: string; position: number; config_json: string | null }>;
  let planJson: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.plan_json ?? '{}'));
    planJson = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    planJson = {};
  }
  return {
    id: String(row.id),
    themeId: String(row.theme_id),
    version: Number(row.version),
    researchStateVersion: Number(row.research_state_version),
    objective: String(row.objective ?? ''),
    planJson,
    locked: Number(row.locked) === 1,
    createdAt: String(row.created_at),
    tools: tools.map((tool, index) => ({
      githubNodeId: tool.github_node_id,
      fullName: tool.full_name,
      role: tool.role,
      acquisitionMode: tool.acquisition_mode,
      position: index,
      config: parseConfig(tool.config_json),
    })),
  };
}

function parseConfig(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function getThemeVersion(themeId: string, version: number): ThemeVersionView | null {
  const row = getDb()
    .prepare('SELECT * FROM fork_lab_theme_versions WHERE theme_id=? AND version=?')
    .get(themeId, version) as Record<string, unknown> | undefined;
  return row ? rowToVersionView(row) : null;
}

export function getThemeVersionById(versionId: string): ThemeVersionView | null {
  const row = getDb().prepare('SELECT * FROM fork_lab_theme_versions WHERE id=?').get(versionId) as Record<string, unknown> | undefined;
  return row ? rowToVersionView(row) : null;
}

/**
 * 保存（或新增版本）主题方案。
 * 主题存在时每次保存都创建新版本；返回 theme 与最新版本。
 */
export function saveThemePlan(topicId: string, options: SaveThemePlanOptions): { theme: ThemePlanView; version: ThemeVersionView } {
  const state = requireCurrentState(topicId);
  const workflow = state.workflow;
  if (!workflow) throw codedError('NO_THEME_WORKFLOW', '请先生成主题主线再保存方案');
  if (!options.name.trim()) throw codedError('THEME_NAME_REQUIRED', '方案名称不能为空');
  const tools = activeSelectedTools(state);
  if (tools.length === 0) throw codedError('NO_TOOLS_SELECTED', '没有可保存的工具');

  const db = getDb();
  const existing = db.prepare('SELECT id FROM fork_lab_themes WHERE research_topic_id=?').get(topicId) as { id?: string } | undefined;
  const themeId = existing?.id ?? `theme-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  const save = db.transaction(() => {
    if (!existing) {
      db.prepare(
        'INSERT INTO fork_lab_themes (id, name, description, research_topic_id, current_version, status, local_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(themeId, options.name.slice(0, 120), options.description?.slice(0, 500) ?? null, topicId, 1, 'DRAFT', 'NOT_STARTED', now, now);
    } else {
      db.prepare('UPDATE fork_lab_themes SET name=?, description=?, updated_at=? WHERE id=?')
        .run(options.name.slice(0, 120), options.description?.slice(0, 500) ?? null, now, themeId);
    }
    const latest = db.prepare('SELECT MAX(version) as version FROM fork_lab_theme_versions WHERE theme_id=?').get(themeId) as { version?: number | null };
    const version = Number(latest?.version ?? 0) + 1;
    const versionId = `theme-version-${randomUUID().slice(0, 8)}`;

    const planJson = buildForkLabPlanJson(state, workflow, options);
    db.prepare(
      'INSERT INTO fork_lab_theme_versions (id, theme_id, version, research_state_version, objective, plan_json, locked, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      versionId, themeId, version, state.version, state.objective || state.title,
      JSON.stringify(planJson), 0, now,
    );
    db.prepare('UPDATE fork_lab_themes SET current_version=?, updated_at=? WHERE id=?').run(version, now, themeId);

    db.prepare('DELETE FROM fork_lab_theme_tools WHERE theme_version_id=?').run(versionId);
    tools.forEach((tool, index) => {
      db.prepare(
        'INSERT INTO fork_lab_theme_tools (id, theme_version_id, github_node_id, full_name, role, acquisition_mode, position, config_json) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        randomUUID(), versionId, tool.githubNodeId, tool.fullName, tool.role, tool.acquisitionMode, index,
        JSON.stringify({ researchStageId: tool.stageId, selectionRole: tool.selectionRole }),
      );
    });
  });
  save();

  const theme = getTheme(themeId) as ThemePlanView;
  const currentVersionRow = db.prepare('SELECT current_version FROM fork_lab_themes WHERE id=?').get(themeId) as { current_version?: number };
  return { theme, version: getThemeVersion(themeId, Number(currentVersionRow.current_version ?? 1)) as ThemeVersionView };
}

function buildForkLabPlanJson(
  state: { title: string; objective: string; version: number; stages: Array<{ id: string; name: string; position: number; required: boolean }>; selectedTools: Array<{ githubNodeId: string; fullName: string; stageId: string; role: string; selectionRole: string; acquisitionMode: string; status: string }> },
  workflow: ThemeWorkflow,
  options: SaveThemePlanOptions,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: options.name,
    description: options.description ?? '',
    objective: state.objective || state.title,
    testGoal: options.testGoal ?? workflow.testGoal ?? '',
    source: 'RESEARCH_GITHUB_SEARCH',
    researchStateVersion: state.version,
    allowAgentModification: options.allowAgentModification ?? false,
    shouldCreateFork: options.shouldCreateFork ?? false,
    retainEnvironment: options.retainEnvironment ?? false,
    workflow,
    successCriteria: workflow.successCriteria,
    stages: workflow.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      researchStageId: stage.researchStageId,
      toolIds: stage.toolIds,
      inputs: stage.inputs,
      outputs: stage.outputs,
    })),
    tools: state.selectedTools
      .filter((tool) => tool.selectionRole !== 'EXCLUDED' && tool.status !== 'REMOVED_BY_USER')
      .map((tool) => ({
        githubNodeId: tool.githubNodeId,
        fullName: tool.fullName,
        role: tool.role,
        stageId: tool.stageId,
        selectionRole: tool.selectionRole,
        acquisitionMode: tool.acquisitionMode,
      })),
    manualHandoffs: workflow.manualHandoffs,
    // 刻意不包含任何日报 / Top100 / 热点字段。
  };
}

/** 锁定主题版本：锁定后不可原地覆盖，只能生成新版本。 */
export function lockThemeVersion(versionId: string): ThemeVersionView {
  const row = getDb().prepare('SELECT theme_id FROM fork_lab_theme_versions WHERE id=?').get(versionId) as { theme_id?: string } | undefined;
  if (!row) throw codedError('THEME_VERSION_NOT_FOUND', '主题版本不存在');
  getDb().prepare('UPDATE fork_lab_theme_versions SET locked=1 WHERE id=?').run(versionId);
  return getThemeVersionById(versionId) as ThemeVersionView;
}

/** 删除主题方案（保留版本历史？方案要求锁定版本不可覆盖，删除走整主题删除）。 */
export function deleteTheme(themeId: string): void {
  requireTheme(themeId);
  const db = getDb();
  const remove = db.transaction(() => {
    const versions = db.prepare('SELECT id FROM fork_lab_theme_versions WHERE theme_id=?').all(themeId) as Array<{ id: string }>;
    for (const version of versions) {
      db.prepare('DELETE FROM fork_lab_theme_tools WHERE theme_version_id=?').run(version.id);
    }
    db.prepare('DELETE FROM fork_lab_theme_versions WHERE theme_id=?').run(themeId);
    db.prepare('DELETE FROM fork_lab_themes WHERE id=?').run(themeId);
  });
  remove();
}
