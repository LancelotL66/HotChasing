import { changeImpactSchema, type ChangeImpact, type ChangeOperation } from '../state/researchOperations.js';
import type { ResearchState } from '../state/researchStateSchema.js';

/**
 * 影响分析：确认预览中的“修改会波及什么”。
 * 只做范围判断，不修改状态；用于决定是否需要局部搜索、重新分类、重建主线或生成新的 Fork 方案版本。
 */

const FULL_SEARCH_REQUIREMENT_FIELDS = new Set(['languages', 'domains', 'platforms']);

export function analyzeImpact(state: ResearchState, operations: ChangeOperation[]): ChangeImpact {
  const stagesAffected = new Set<string>();
  const toolsAffected = new Set<string>();
  const searchRequired = new Set<string>();
  let fullSearchRequired = false;
  let toolReclassificationRequired = false;
  let workflowRegenerationRequired = false;
  let forkPlanAffected = false;

  const toolsOfStage = (stageId: string) =>
    state.selectedTools.filter((tool) => tool.stageId === stageId).map((tool) => tool.fullName);

  for (const operation of operations) {
    switch (operation.type) {
      case 'UPDATE_OBJECTIVE':
        fullSearchRequired = true;
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        break;
      case 'UPDATE_REQUIREMENT': {
        for (const key of Object.keys(operation.patch)) {
          if (FULL_SEARCH_REQUIREMENT_FIELDS.has(key)) fullSearchRequired = true;
        }
        toolReclassificationRequired = true;
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        for (const tool of state.selectedTools) toolsAffected.add(tool.fullName);
        break;
      }
      case 'ADD_STAGE': {
        const id = operation.temporaryId ?? operation.name;
        stagesAffected.add(id);
        searchRequired.add(id);
        toolReclassificationRequired = true;
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        break;
      }
      case 'UPDATE_STAGE':
        stagesAffected.add(operation.stageId);
        if (operation.inputs || operation.outputs) workflowRegenerationRequired = true;
        break;
      case 'DELETE_STAGE':
        stagesAffected.add(operation.stageId);
        for (const name of toolsOfStage(operation.stageId)) toolsAffected.add(name);
        toolReclassificationRequired = true;
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        break;
      case 'REORDER_STAGE':
        for (const id of operation.stageOrder) stagesAffected.add(id);
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        break;
      case 'SPLIT_STAGE':
        stagesAffected.add(operation.stageId);
        for (const part of operation.parts) searchRequired.add(part.name);
        for (const name of toolsOfStage(operation.stageId)) toolsAffected.add(name);
        toolReclassificationRequired = true;
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        break;
      case 'MERGE_STAGES':
        for (const id of operation.stageIds) {
          stagesAffected.add(id);
          for (const name of toolsOfStage(id)) toolsAffected.add(name);
        }
        toolReclassificationRequired = true;
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        break;
      case 'MARK_STAGE_REQUIRED':
      case 'MARK_STAGE_OPTIONAL':
        stagesAffected.add(operation.stageId);
        workflowRegenerationRequired = true;
        break;
      case 'ADD_TOOL_CONSTRAINT':
      case 'REMOVE_TOOL_CONSTRAINT':
        stagesAffected.add(operation.stageId);
        searchRequired.add(operation.stageId);
        break;
      case 'SELECT_TOOL':
      case 'ADD_ALTERNATIVE_TOOL':
        stagesAffected.add(operation.stageId);
        toolsAffected.add(operation.fullName);
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        break;
      case 'REMOVE_TOOL': {
        const tool = state.selectedTools.find((item) => item.githubNodeId === operation.githubNodeId);
        if (tool) { toolsAffected.add(tool.fullName); stagesAffected.add(tool.stageId); }
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        break;
      }
      case 'CHANGE_PRIMARY_TOOL': {
        stagesAffected.add(operation.stageId);
        const tool = state.selectedTools.find((item) => item.githubNodeId === operation.githubNodeId);
        if (tool) toolsAffected.add(tool.fullName);
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        break;
      }
      case 'REPLACE_TOOL': {
        const tool = state.selectedTools.find((item) => item.githubNodeId === operation.githubNodeId);
        if (tool) { toolsAffected.add(tool.fullName); stagesAffected.add(tool.stageId); }
        toolsAffected.add(operation.replacementFullName);
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        break;
      }
      case 'UPDATE_WORKFLOW':
      case 'UPDATE_TEST_SCOPE':
        workflowRegenerationRequired = true;
        forkPlanAffected = true;
        break;
      case 'LOCK_FIELD':
      case 'UNLOCK_FIELD':
        break;
      default:
        break;
    }
  }

  const summaryRows: Array<{ item: string; impact: string }> = [];
  const added = operations.filter((operation) => operation.type === 'ADD_STAGE').length;
  const deleted = operations.filter((operation) => operation.type === 'DELETE_STAGE').length;
  if (added > 0 || deleted > 0) {
    summaryRows.push({ item: '研究环节', impact: `${deleted > 0 ? `删除 ${deleted} 个` : ''}${deleted > 0 && added > 0 ? '，' : ''}${added > 0 ? `新增 ${added} 个` : ''}` });
  } else if (stagesAffected.size > 0) {
    summaryRows.push({ item: '研究环节', impact: `影响 ${stagesAffected.size} 个环节` });
  }
  if (toolsAffected.size > 0) {
    summaryRows.push({ item: '已选工具', impact: `${[...toolsAffected].slice(0, 4).join('、')}${toolsAffected.size > 4 ? ' 等' : ''} 需要重新确认` });
  }
  summaryRows.push({
    item: 'GitHub 搜索',
    impact: fullSearchRequired ? '需要全量重新搜索' : searchRequired.size > 0 ? `只搜索 ${[...searchRequired].join('、')}` : '无需重新搜索',
  });
  summaryRows.push({ item: '主题主线', impact: workflowRegenerationRequired ? '需要生成新版本' : '不受影响' });
  summaryRows.push({ item: 'Fork 方案', impact: forkPlanAffected ? '原版本保留，确认后创建新版本' : '不受影响' });

  return changeImpactSchema.parse({
    stagesAffected: [...stagesAffected],
    toolsAffected: [...toolsAffected],
    searchRequired: [...searchRequired],
    fullSearchRequired,
    toolReclassificationRequired,
    workflowRegenerationRequired,
    forkPlanAffected,
    summaryRows,
  });
}
