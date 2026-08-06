import type { ConsistencyStatus, ResearchState } from './researchStateSchema.js';

/**
 * ResearchConsistencyValidator：主题内所有模块共享的一致性判定。
 * 只读，不修改 Research State；结果用于提案确认预览与页面提示。
 */

export interface ConsistencyIssue {
  code: string;
  severity: 'BLOCKING' | 'WARNING' | 'INFO';
  message: string;
  stageId?: string;
  toolId?: string;
  options?: string[];
}

export interface ConsistencyResult {
  status: ConsistencyStatus;
  issues: ConsistencyIssue[];
}

const activeTools = (state: ResearchState) =>
  state.selectedTools.filter((tool) => tool.status !== 'REMOVED_BY_USER' && tool.selectionRole !== 'EXCLUDED');

function validateStages(state: ResearchState, issues: ConsistencyIssue[]): void {
  const seen = new Set<string>();
  for (const stage of state.stages) {
    if (seen.has(stage.id)) {
      issues.push({ code: 'STAGE_ID_DUPLICATE', severity: 'BLOCKING', message: `研究环节 ID 重复：${stage.id}`, stageId: stage.id });
    }
    seen.add(stage.id);
  }
  const positions = state.stages.map((stage) => stage.position);
  const sorted = [...positions].sort((a, b) => a - b);
  if (positions.some((position, index) => position !== sorted[index])) {
    issues.push({ code: 'STAGE_ORDER_INVALID', severity: 'WARNING', message: '研究环节顺序未规范化，需要重新编号。' });
  }
  if (state.stages.length === 0) {
    issues.push({ code: 'NO_STAGE', severity: 'BLOCKING', message: '当前没有任何研究环节，无法搜索或生成主线。' });
  }
  if (state.stages.length > 0 && !state.stages.some((stage) => stage.required)) {
    issues.push({ code: 'NO_REQUIRED_STAGE', severity: 'WARNING', message: '所有研究环节都是可选，端到端验证将没有必选成功标准。' });
  }
  for (let index = 1; index < state.stages.length; index += 1) {
    const previous = state.stages[index - 1];
    const current = state.stages[index];
    if (previous.outputs.length > 0 && current.inputs.length > 0) {
      const connectable = current.inputs.some((input) => previous.outputs.some((output) => output.includes(input) || input.includes(output)));
      if (!connectable) {
        issues.push({
          code: 'STAGE_IO_NOT_CONNECTABLE',
          severity: 'WARNING',
          message: `「${previous.name}」的输出与「${current.name}」的输入未声明可连接关系。`,
          stageId: current.id,
        });
      }
    }
  }
}

function validateTools(state: ResearchState, issues: ConsistencyIssue[]): void {
  const stageIds = new Set(state.stages.map((stage) => stage.id));
  const primaryByStage = new Map<string, number>();
  for (const tool of activeTools(state)) {
    if (!tool.stageId || !stageIds.has(tool.stageId)) {
      issues.push({
        code: 'TOOL_UNASSIGNED',
        severity: 'WARNING',
        message: `工具 ${tool.fullName} 当前未归属任何研究环节。`,
        toolId: tool.githubNodeId,
        options: ['重新归类到现有环节', '新增对应研究环节', '从工具链移除'],
      });
      continue;
    }
    if (tool.selectionRole === 'PRIMARY') {
      primaryByStage.set(tool.stageId, (primaryByStage.get(tool.stageId) ?? 0) + 1);
    }
    if (tool.status === 'NEEDS_RECLASSIFICATION') {
      issues.push({ code: 'TOOL_NEEDS_RECLASSIFICATION', severity: 'WARNING', message: `工具 ${tool.fullName} 因环节结构变化需要重新确认归类。`, toolId: tool.githubNodeId });
    }
  }
  for (const [stageId, count] of primaryByStage) {
    if (count > 1) {
      const stage = state.stages.find((item) => item.id === stageId);
      issues.push({ code: 'MULTIPLE_PRIMARY_TOOLS', severity: 'BLOCKING', message: `研究环节「${stage?.name ?? stageId}」存在 ${count} 个主工具。`, stageId });
    }
  }
  for (const stage of state.stages) {
    if (!stage.required) continue;
    if (!primaryByStage.get(stage.id)) {
      issues.push({
        code: 'STAGE_MISSING_PRIMARY_TOOL',
        severity: 'WARNING',
        message: `必选研究环节「${stage.name}」尚未选择主工具。`,
        stageId: stage.id,
        options: ['继续搜索该环节工具', '把现有备选工具设为主工具', '将该环节改为可选'],
      });
    }
  }
}

function validateWorkflow(state: ResearchState, issues: ConsistencyIssue[]): void {
  const workflow = state.workflow;
  if (!workflow) return;
  const stageIds = new Set(state.stages.map((stage) => stage.id));
  const toolIds = new Set(activeTools(state).map((tool) => tool.githubNodeId));
  const workflowStageIds = new Set(workflow.stages.map((stage) => stage.id));
  for (const stage of workflow.stages) {
    if (stage.researchStageId && !stageIds.has(stage.researchStageId)) {
      issues.push({ code: 'WORKFLOW_STAGE_ORPHANED', severity: 'BLOCKING', message: `主线阶段「${stage.name}」引用了已不存在的研究环节。` });
    }
    for (const toolId of stage.toolIds) {
      if (!toolIds.has(toolId)) {
        issues.push({ code: 'WORKFLOW_TOOL_REMOVED', severity: 'BLOCKING', message: `主线阶段「${stage.name}」引用了已被移除或排除的工具。` });
      }
    }
  }
  for (const connection of workflow.connections) {
    if (!workflowStageIds.has(connection.from) || !workflowStageIds.has(connection.to)) {
      issues.push({ code: 'WORKFLOW_CONNECTION_DANGLING', severity: 'BLOCKING', message: `主线连接 ${connection.from} → ${connection.to} 指向不存在的阶段。` });
    }
    if (connection.from === connection.to) {
      issues.push({ code: 'WORKFLOW_SELF_LOOP', severity: 'BLOCKING', message: `主线阶段 ${connection.from} 存在自循环。` });
    }
  }
  if (workflow.stages.length > 0 && workflow.successCriteria.length === 0) {
    issues.push({ code: 'WORKFLOW_NO_SUCCESS_CRITERIA', severity: 'WARNING', message: '主题主线尚未定义端到端成功标准。' });
  }
}

function validateConstraints(state: ResearchState, issues: ConsistencyIssue[], toolFacts: ToolFacts): void {
  const requirements = state.requirements;
  for (const tool of activeTools(state)) {
    const facts = toolFacts[tool.githubNodeId];
    if (!facts) continue;
    if (!requirements.gpuAllowed && facts.gpuRequired) {
      issues.push({
        code: 'CONSTRAINT_GPU_CONFLICT',
        severity: 'BLOCKING',
        message: `当前限制不使用 GPU，但 ${tool.fullName} 需要 GPU。`,
        toolId: tool.githubNodeId,
        options: [`替换 ${tool.fullName}`, '放宽 GPU 限制', `保留 ${tool.fullName} 但标记为不可执行`, '取消调整'],
      });
    }
    if (!requirements.paidApiAllowed && facts.paidApiRequired) {
      issues.push({
        code: 'CONSTRAINT_PAID_API_CONFLICT',
        severity: 'BLOCKING',
        message: `当前限制不使用付费 API，但 ${tool.fullName} 依赖付费 API。`,
        toolId: tool.githubNodeId,
        options: [`替换 ${tool.fullName}`, '放宽付费 API 限制', '保留但标记为不可执行', '取消调整'],
      });
    }
    if (requirements.localDeploymentPreferred && facts.localSupported === false) {
      issues.push({
        code: 'CONSTRAINT_LOCAL_DEPLOY_CONFLICT',
        severity: 'WARNING',
        message: `${tool.fullName} 不支持本地部署，与本地优先偏好冲突。`,
        toolId: tool.githubNodeId,
      });
    }
    if (requirements.languages.length > 0 && facts.language && !requirements.languages.some((language) => language.toLowerCase() === facts.language?.toLowerCase())) {
      issues.push({
        code: 'CONSTRAINT_LANGUAGE_MISMATCH',
        severity: 'WARNING',
        message: `${tool.fullName} 主语言为 ${facts.language}，不在当前语言约束内。`,
        toolId: tool.githubNodeId,
      });
    }
  }
  const languages = new Set(
    activeTools(state)
      .map((tool) => toolFacts[tool.githubNodeId]?.language)
      .filter((language): language is string => Boolean(language)),
  );
  if (languages.size >= 2) {
    issues.push({
      code: 'TOOLKIT_MULTIPLE_RUNTIMES',
      severity: 'INFO',
      message: `当前工具链需要 ${[...languages].join(' 与 ')} 多套环境。`,
    });
  }
}

export type ToolFacts = Record<string, {
  language?: string | null;
  gpuRequired?: boolean;
  paidApiRequired?: boolean;
  localSupported?: boolean;
  roles?: string[];
}>;

function deriveStatus(state: ResearchState, issues: ConsistencyIssue[]): ConsistencyStatus {
  if (issues.some((issue) => issue.severity === 'BLOCKING' && issue.code.startsWith('CONSTRAINT_'))) return 'CONFLICTED';
  if (issues.some((issue) => issue.code === 'WORKFLOW_TOOL_REMOVED' || issue.code === 'WORKFLOW_STAGE_ORPHANED' || issue.code === 'WORKFLOW_CONNECTION_DANGLING')) return 'NEEDS_WORKFLOW_UPDATE';
  if (issues.some((issue) => issue.code === 'TOOL_NEEDS_RECLASSIFICATION' || issue.code === 'TOOL_UNASSIGNED')) return 'NEEDS_TOOL_RECLASSIFICATION';
  if (state.stages.some((stage) => stage.required && stage.searchStatus === 'NOT_STARTED')) return 'NEEDS_PARTIAL_SEARCH';
  if (issues.some((issue) => issue.code === 'STAGE_MISSING_PRIMARY_TOOL')) return 'NEEDS_RESEARCH_UPDATE';
  if (issues.some((issue) => issue.severity === 'BLOCKING')) return 'CONFLICTED';
  return 'CONSISTENT';
}

export function validateResearchState(state: ResearchState, toolFacts: ToolFacts = {}): ConsistencyResult {
  const issues: ConsistencyIssue[] = [];
  validateStages(state, issues);
  validateTools(state, issues);
  validateWorkflow(state, issues);
  validateConstraints(state, issues, toolFacts);
  return { status: deriveStatus(state, issues), issues };
}
