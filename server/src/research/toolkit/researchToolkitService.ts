import { requireCurrentState } from '../state/researchStateService.js';
import { applyAndSave, type ApplyResult } from '../state/researchStateWriter.js';
import { getToolAnalysis } from '../analysis/researchToolFacts.js';
import { listCandidates, type CandidateView } from '../github/researchSearchService.js';
import type { ChangeOperation } from '../state/researchOperations.js';
import type { AcquisitionMode, ResearchRole, ResearchState, SelectionRole } from '../state/researchStateSchema.js';

/**
 * 我的工具链：主工具 / 备选工具 / 覆盖状态 / 兼容性 / 缺口与重复提醒。
 * 所有写操作都转换为统一变更操作，经 reducer 与一致性校验后写入新版本。
 */

export interface ToolkitRow {
  stageId: string;
  stageName: string;
  required: boolean;
  primary: { githubNodeId: string; fullName: string; role: string; acquisitionMode: string } | null;
  alternatives: Array<{ githubNodeId: string; fullName: string; role: string }>;
  coverage: '已覆盖' | '缺失' | '待确认';
  compatibility: '正常' | '待分析' | '冲突';
  compatibilityNotes: string[];
}

export interface ToolkitView {
  rows: ToolkitRow[];
  unassigned: Array<{ githubNodeId: string; fullName: string; status: string }>;
  excluded: Array<{ githubNodeId: string; fullName: string; notes: string }>;
  reminders: string[];
  gaps: string[];
  duplicates: string[];
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function activeTools(state: ResearchState) {
  return state.selectedTools.filter((tool) => tool.status !== 'REMOVED_BY_USER' && tool.selectionRole !== 'EXCLUDED');
}

export function getToolkit(topicId: string): ToolkitView {
  const state = requireCurrentState(topicId);
  const tools = activeTools(state);
  const rows: ToolkitRow[] = [];
  const reminders: string[] = [];
  const gaps: string[] = [];
  const duplicates: string[] = [];

  for (const stage of state.stages) {
    const stageTools = tools.filter((tool) => tool.stageId === stage.id);
    const primary = stageTools.find((tool) => tool.selectionRole === 'PRIMARY') ?? null;
    const alternatives = stageTools.filter((tool) => tool.selectionRole !== 'PRIMARY');
    const notes: string[] = [];
    let compatibility: ToolkitRow['compatibility'] = '待分析';
    if (primary) {
      const analysis = getToolAnalysis(topicId, primary.githubNodeId);
      if (!analysis) {
        notes.push('尚未生成结构化分析，兼容性未知');
      } else {
        compatibility = '正常';
        if (!state.requirements.gpuAllowed && analysis.deployment.gpuRequired) {
          compatibility = '冲突';
          notes.push('该工具需要 GPU，违反当前无 GPU 限制');
        }
        if (!state.requirements.paidApiAllowed && analysis.deployment.paidApiRequired) {
          compatibility = '冲突';
          notes.push('该工具依赖付费 API，违反当前限制');
        }
        if (state.requirements.localDeploymentPreferred && !analysis.deployment.localSupported) {
          compatibility = '冲突';
          notes.push('该工具不支持本地部署');
        }
        if (analysis.inputs.length === 0 || analysis.outputs.length === 0) {
          notes.push('输入或输出未明确，串联时需要人工确认');
        }
      }
    }
    const coverage: ToolkitRow['coverage'] = primary ? '已覆盖' : alternatives.length > 0 ? '待确认' : '缺失';
    if (stage.required && coverage === '缺失') gaps.push(`必选环节「${stage.name}」缺少工具`);
    if (stage.required && coverage === '待确认') gaps.push(`必选环节「${stage.name}」尚未指定主工具`);
    rows.push({
      stageId: stage.id,
      stageName: stage.name,
      required: stage.required,
      primary: primary ? { githubNodeId: primary.githubNodeId, fullName: primary.fullName, role: primary.role, acquisitionMode: primary.acquisitionMode } : null,
      alternatives: alternatives.map((tool) => ({ githubNodeId: tool.githubNodeId, fullName: tool.fullName, role: tool.role })),
      coverage,
      compatibility,
      compatibilityNotes: notes,
    });
  }

  // 功能重复：同一环节多个工具具有完全相同的角色集合。
  for (const stage of state.stages) {
    const stageTools = tools.filter((tool) => tool.stageId === stage.id);
    const byRole = new Map<string, string[]>();
    for (const tool of stageTools) {
      const analysis = getToolAnalysis(topicId, tool.githubNodeId);
      const key = (analysis?.roles ?? [tool.role]).slice().sort().join('+');
      const list = byRole.get(key) ?? [];
      list.push(tool.fullName);
      byRole.set(key, list);
    }
    for (const [, names] of byRole) {
      if (names.length >= 2) duplicates.push(`「${stage.name}」中 ${names.join(' 与 ')} 功能高度重叠`);
    }
  }

  const languages = new Set(
    tools
      .map((tool) => listRepoLanguage(topicId, tool.githubNodeId))
      .filter((language): language is string => Boolean(language)),
  );
  if (languages.size >= 2) reminders.push(`当前工具链需要 ${[...languages].join(' 与 ')} 多套环境`);
  if (gaps.length > 0) reminders.push(...gaps);
  if (duplicates.length > 0) reminders.push(...duplicates);
  const gpuConflicts = tools.filter((tool) => !state.requirements.gpuAllowed && getToolAnalysis(topicId, tool.githubNodeId)?.deployment.gpuRequired);
  if (gpuConflicts.length > 0) reminders.push(`当前选中工具 ${gpuConflicts.map((tool) => tool.fullName).join('、')} 违反无 GPU 限制`);
  const unconnectable = rows.filter((row) => row.compatibilityNotes.some((note) => note.includes('输入或输出未明确')));
  if (unconnectable.length > 0) reminders.push('部分工具的输入输出未明确，串联前需要人工确认数据交换方式');

  return {
    rows,
    unassigned: state.selectedTools
      .filter((tool) => tool.status === 'UNASSIGNED' || tool.status === 'NEEDS_RECLASSIFICATION')
      .map((tool) => ({ githubNodeId: tool.githubNodeId, fullName: tool.fullName, status: tool.status })),
    excluded: state.selectedTools
      .filter((tool) => tool.status === 'REMOVED_BY_USER' || tool.selectionRole === 'EXCLUDED')
      .map((tool) => ({ githubNodeId: tool.githubNodeId, fullName: tool.fullName, notes: tool.notes })),
    reminders: [...new Set(reminders)],
    gaps: [...new Set(gaps)],
    duplicates: [...new Set(duplicates)],
  };
}

function listRepoLanguage(topicId: string, githubNodeId: string): string | null {
  const candidate = listCandidates(topicId).find((item) => item.github_node_id === githubNodeId);
  return candidate?.repo?.primaryLanguage ?? null;
}

export interface SelectToolInput {
  githubNodeId: string;
  stageId?: string;
  selectionRole?: SelectionRole;
  role?: ResearchRole;
  acquisitionMode?: AcquisitionMode;
  notes?: string;
}

export function selectTool(topicId: string, input: SelectToolInput): ApplyResult {
  const state = requireCurrentState(topicId);
  const candidate = listCandidates(topicId).find((item) => item.github_node_id === input.githubNodeId);
  if (!candidate) throw codedError('RESEARCH_CANDIDATE_NOT_FOUND', '候选工具不存在，请先搜索');
  const stageId = input.stageId ?? candidate.stage_id ?? candidate.analysis?.stageIds[0] ?? state.stages[0]?.id;
  if (!stageId) throw codedError('NO_RESEARCH_STAGE', '当前没有研究环节，无法归类工具');
  const analysis = candidate.analysis;
  const operation: ChangeOperation = {
    type: 'SELECT_TOOL',
    githubNodeId: input.githubNodeId,
    fullName: candidate.full_name,
    stageId,
    role: input.role ?? analysis?.roles[0],
    selectionRole: input.selectionRole ?? 'PRIMARY',
    acquisitionMode: input.acquisitionMode ?? analysis?.deployment.preferredAcquisitionMode,
    notes: input.notes ?? '',
  };
  return applyAndSave(topicId, [operation], { summary: `加入工具 ${candidate.full_name}`, actor: 'USER_MANUAL_EDIT' });
}

export function updateTool(topicId: string, githubNodeId: string, patch: { selectionRole?: SelectionRole; stageId?: string; role?: ResearchRole; acquisitionMode?: AcquisitionMode; notes?: string }): ApplyResult {
  const state = requireCurrentState(topicId);
  const tool = state.selectedTools.find((item) => item.githubNodeId === githubNodeId);
  if (!tool) throw codedError('RESEARCH_TOOL_NOT_FOUND', '该工具不在当前工具链中');
  const stageId = patch.stageId ?? tool.stageId;
  if (patch.selectionRole === 'PRIMARY') {
    return applyAndSave(topicId, [{ type: 'CHANGE_PRIMARY_TOOL', stageId, githubNodeId }], {
      summary: `将 ${tool.fullName} 设为「${state.stages.find((stage) => stage.id === stageId)?.name ?? stageId}」主工具`,
      actor: 'USER_MANUAL_EDIT',
    });
  }
  const operation: ChangeOperation = {
    type: 'SELECT_TOOL',
    githubNodeId,
    fullName: tool.fullName,
    stageId,
    role: patch.role ?? tool.role,
    selectionRole: patch.selectionRole ?? tool.selectionRole,
    acquisitionMode: patch.acquisitionMode ?? tool.acquisitionMode,
    notes: patch.notes ?? tool.notes,
  };
  return applyAndSave(topicId, [operation], { summary: `更新工具 ${tool.fullName}`, actor: 'USER_MANUAL_EDIT' });
}

export function removeTool(topicId: string, githubNodeId: string, reason = ''): ApplyResult {
  const state = requireCurrentState(topicId);
  const tool = state.selectedTools.find((item) => item.githubNodeId === githubNodeId);
  if (!tool) throw codedError('RESEARCH_TOOL_NOT_FOUND', '该工具不在当前工具链中');
  return applyAndSave(topicId, [{ type: 'REMOVE_TOOL', githubNodeId, reason }], {
    summary: `移除工具 ${tool.fullName}`,
    actor: 'USER_MANUAL_EDIT',
  });
}

/**
 * 寻找替代工具：从当前主题已有候选中筛选同环节、角色相近、且不违反约束的仓库。
 * 不自动加入工具链，只返回建议，由用户确认。
 */
export function findAlternatives(topicId: string, githubNodeId: string, limit = 8): CandidateView[] {
  const state = requireCurrentState(topicId);
  const target = listCandidates(topicId).find((item) => item.github_node_id === githubNodeId);
  const tool = state.selectedTools.find((item) => item.githubNodeId === githubNodeId);
  const stageId = tool?.stageId ?? target?.stage_id ?? null;
  const targetRoles = new Set(target?.analysis?.roles ?? []);
  const selectedIds = new Set(state.selectedTools.map((item) => item.githubNodeId));
  return listCandidates(topicId)
    .filter((candidate) => candidate.github_node_id !== githubNodeId)
    .filter((candidate) => !selectedIds.has(candidate.github_node_id))
    .filter((candidate) => (stageId ? candidate.stage_id === stageId : true))
    .filter((candidate) => candidate.match_level !== '不符合当前限制')
    .filter((candidate) => {
      if (targetRoles.size === 0) return true;
      const roles = candidate.analysis?.roles ?? [];
      return roles.length === 0 || roles.some((role) => targetRoles.has(role));
    })
    .slice(0, limit);
}

export interface CompatibilityReport {
  runtimeLanguages: string[];
  gaps: string[];
  duplicates: string[];
  conflicts: string[];
  handoffs: string[];
}

export function checkCompatibility(topicId: string): CompatibilityReport {
  const state = requireCurrentState(topicId);
  const toolkit = getToolkit(topicId);
  const conflicts: string[] = [];
  const handoffs: string[] = [];
  for (const row of toolkit.rows) {
    for (const note of row.compatibilityNotes) {
      if (note.includes('违反') || note.includes('不支持')) conflicts.push(`${row.stageName}：${note}`);
      if (note.includes('输入或输出未明确')) handoffs.push(`${row.stageName}：可能需要人工衔接`);
    }
  }
  const languages = new Set(
    activeTools(state)
      .map((tool) => listRepoLanguage(topicId, tool.githubNodeId))
      .filter((language): language is string => Boolean(language)),
  );
  return {
    runtimeLanguages: [...languages],
    gaps: toolkit.gaps,
    duplicates: toolkit.duplicates,
    conflicts: [...new Set(conflicts)],
    handoffs: [...new Set(handoffs)],
  };
}
