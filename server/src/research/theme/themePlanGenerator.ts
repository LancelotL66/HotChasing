import {
  themeWorkflowSchema,
  type SelectedTool,
  type ThemeWorkflow,
  type WorkflowStage,
} from '../state/researchStateSchema.js';
import { requireCurrentState, saveNewVersion } from '../state/researchStateService.js';
import { getToolAnalysis } from '../analysis/researchToolFacts.js';
import { requestResearchJson } from '../ai/researchAi.js';
import { getDb } from '../../db/connection.js';

/**
 * ThemePlanGenerator：把用户选中的工具串成一条建议研究主线。
 *
 * 规则（来自方案第 17 节）：
 * - 只使用当前 Research State 中已选工具，AI 不得未经同意自动加入新仓库；
 * - 识别功能重复与缺失环节，分别写入 duplicateTools / missingStages；
 * - 主线阶段必须来自当前 Research State；被锁定节点不能被替换；
 * - 人工衔接必须显式标记。
 */

export interface ThemePlanResult {
  workflow: ThemeWorkflow;
  source: 'ai' | 'rule';
  model: string | null;
}

function activeTools(state: { selectedTools: SelectedTool[] }): SelectedTool[] {
  return state.selectedTools.filter((tool) => tool.status !== 'REMOVED_BY_USER' && tool.selectionRole !== 'EXCLUDED');
}

function workflowStageId(name: string, existing: string[]): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = /^[a-z0-9-]+$/.test(ascii) && ascii.length > 0 ? ascii : `stage-${existing.length + 1}`;
  if (!existing.includes(base)) return base;
  let index = 2;
  while (existing.includes(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

/** 规则兜底：按研究环节顺序线性排列工具，人工衔接交给用户确认。 */
export function buildWorkflowByRules(topicId: string): ThemeWorkflow {
  const state = requireCurrentState(topicId);
  const tools = activeTools(state);
  const toolsByStage = new Map<string, SelectedTool[]>();
  for (const tool of tools) {
    const list = toolsByStage.get(tool.stageId) ?? [];
    list.push(tool);
    toolsByStage.set(tool.stageId, list);
  }
  const stages: WorkflowStage[] = [];
  const connections: ThemeWorkflow['connections'] = [];
  const manualHandoffs: string[] = [];
  const existingIds: string[] = [];

  const orderedStages = [...state.stages].sort((a, b) => a.position - b.position).filter((stage) => toolsByStage.has(stage.id));
  for (const researchStage of orderedStages) {
    const stageTools = (toolsByStage.get(researchStage.id) ?? []).sort((a, b) => {
      if (a.selectionRole === 'PRIMARY' && b.selectionRole !== 'PRIMARY') return -1;
      if (b.selectionRole === 'PRIMARY' && a.selectionRole !== 'PRIMARY') return 1;
      return 0;
    });
    const id = workflowStageId(stageTools[0]?.fullName.split('/').pop() ?? researchStage.name, existingIds);
    existingIds.push(id);
    const toolIds = stageTools.map((tool) => tool.githubNodeId);
    const inputs = [...new Set(stageTools.flatMap((tool) => getToolAnalysis(topicId, tool.githubNodeId)?.inputs ?? []))];
    const outputs = [...new Set(stageTools.flatMap((tool) => getToolAnalysis(topicId, tool.githubNodeId)?.outputs ?? []))];
    stages.push({
      id,
      name: researchStage.name,
      researchStageId: researchStage.id,
      toolIds,
      inputs: inputs.length > 0 ? inputs : researchStage.inputs,
      outputs: outputs.length > 0 ? outputs : researchStage.outputs,
      manualStep: stageTools.some((tool) => getToolAnalysis(topicId, tool.githubNodeId)?.deployment.credentialsRequired),
      requiresCredentials: stageTools.some((tool) => getToolAnalysis(topicId, tool.githubNodeId)?.deployment.credentialsRequired),
      requiresUserData: stageTools.some((tool) => (getToolAnalysis(topicId, tool.githubNodeId)?.deployment.credentialsRequired ?? false)),
      locked: false,
      notes: '',
    });
    if (stageTools.length === 0) manualHandoffs.push(researchStage.name);
  }

  for (let index = 0; index < stages.length - 1; index += 1) {
    const from = stages[index];
    const to = stages[index + 1];
    const fromAnalysis = from.toolIds.map((toolId) => getToolAnalysis(topicId, toolId)).filter(Boolean);
    const toAnalysis = to.toolIds.map((toolId) => getToolAnalysis(topicId, toolId)).filter(Boolean);
    const allLibraries = [...fromAnalysis, ...toAnalysis].every((analysis) => analysis?.productForm.includes('LIBRARY'));
    connections.push({
      from: from.id,
      to: to.id,
      mode: allLibraries ? 'LIBRARY_CALL' : 'FILE_EXCHANGE',
      payload: '',
    });
  }

  const missingStages = state.stages.filter((stage) => !toolsByStage.has(stage.id)).map((stage) => stage.name);
  const duplicateTools: string[] = [];
  for (const stage of state.stages) {
    const stageTools = toolsByStage.get(stage.id) ?? [];
    const byRole = new Map<string, string[]>();
    for (const tool of stageTools) {
      const analysis = getToolAnalysis(topicId, tool.githubNodeId);
      const key = (analysis?.roles ?? [tool.role]).slice().sort().join('+');
      const list = byRole.get(key) ?? [];
      list.push(tool.fullName);
      byRole.set(key, list);
    }
    for (const [, names] of byRole) {
      if (names.length >= 2) duplicateTools.push(`${names.join(' 与 ')} 功能重叠`);
    }
  }

  return themeWorkflowSchema.parse({
    name: `${state.title} 建议主线`,
    description: 'AI 或规则根据已选工具生成的研究主线',
    testGoal: '',
    themeInputs: state.stages[0]?.inputs ?? [],
    finalOutputs: state.stages[state.stages.length - 1]?.outputs ?? [],
    stages,
    connections,
    successCriteria: [
      '从主题输入到最终输出的链路可以按主线顺序执行',
      '每个主工具的版本固定并可复现',
    ],
    manualHandoffs,
    missingStages,
    duplicateTools,
    source: 'AI_GENERATED',
    version: 1,
  });
}

function toolSummary(topicId: string, tool: SelectedTool): string {
  const analysis = getToolAnalysis(topicId, tool.githubNodeId);
  return `- ${tool.fullName}（环节=${tool.stageId}，角色=${tool.role}，形态=${analysis?.productForm.join('/') ?? '未知'}，输入=${analysis?.inputs.join(',') || '无'}，输出=${analysis?.outputs.join(',') || '无'}，获取=${tool.acquisitionMode}，本地=${analysis?.deployment.localSupported ?? '未知'}，Docker=${analysis?.deployment.dockerAvailable ?? '未知'}，GPU=${analysis?.deployment.gpuRequired ?? '未知'}）`;
}

const WORKFLOW_GUIDANCE = `你是开源研究工具链编排专家。请把用户选中的工具排成一条线性研究主线（Theme Workflow）。

硬性规则：
1. 只能使用下面的“已选工具”列表，不得新增任何仓库；缺少环节时把环节名写入 missingStages；
2. stages 必须按数据流向排列（数据 → 处理 → 建模 → 评估 → 展示）；
3. 每个主线阶段的 id 用短横线小写英文命名，name 用中文；
4. toolIds 只使用已选工具的 githubNodeId；
5. connections 的 from / to 必须是 stages 中存在的 id；mode 只能是 LIBRARY_CALL|CLI_CALL|FILE_EXCHANGE|HTTP_API|RPC|MCP|DATABASE|MESSAGE_QUEUE|MANUAL_HANDOFF；
6. 需要用户提供凭据或手动导入数据的阶段，把 manualStep 设为 true 并写入手动步骤说明；
7. 两个工具功能高度重叠时写入 duplicateTools；有环节没选到工具时写入 missingStages；
8. themeInputs / finalOutputs / successCriteria 都要填写；successCriteria 是端到端成功标准；
9. 只返回 JSON，字段：name,description,testGoal,themeInputs,finalOutputs,stages[{id,name,researchStageId,toolIds,inputs,outputs,manualStep,requiresCredentials,requiresUserData,locked,notes}],connections[{from,to,mode,payload}],successCriteria,manualHandoffs,missingStages,duplicateTools,source,version。`;

export async function generateThemePlan(topicId: string): Promise<ThemePlanResult> {
  const state = requireCurrentState(topicId);
  const tools = activeTools(state);
  if (tools.length === 0) {
    throw Object.assign(new Error('请先选择至少一个工具再加入主线'), { code: 'NO_TOOLS_SELECTED' });
  }
  const fallback = buildWorkflowByRules(topicId);
  const stageList = state.stages
    .map((stage) => `- ${stage.id}｜${stage.name}｜必选=${stage.required}｜锁定=${stage.locked}`)
    .join('\n');
  const prompt = `${WORKFLOW_GUIDANCE}

研究主题：${state.title}
研究目标：${state.objective || '未填写'}
研究环节：
${stageList || '（暂无）'}
已选工具：
${tools.map((tool) => toolSummary(topicId, tool)).join('\n')}`;

  const ai = await requestResearchJson('theme-plan', themeWorkflowSchema, prompt, 2400, 0.1);
  if (!ai.data) return { workflow: fallback, source: 'rule', model: null };
  const data = ai.data;

  // 过滤：只保留已选工具与存在的研究环节；锁定节点不变。
  const toolIds = new Set(tools.map((tool) => tool.githubNodeId));
  const researchStageIds = new Set(state.stages.map((stage) => stage.id));
  const stages = data.stages
    .filter((stage) => stage.toolIds.every((toolId) => toolIds.has(toolId)))
    .filter((stage) => (stage.researchStageId ? researchStageIds.has(stage.researchStageId) : true))
    .map((stage, index) => ({ ...stage, id: workflowStageId(stage.id, data.stages.slice(0, index).map((item) => item.id)) }));
  const stageIds = new Set(stages.map((stage) => stage.id));
  const connections = data.connections.filter((connection) => stageIds.has(connection.from) && stageIds.has(connection.to));
  const duplicateTools = data.duplicateTools.slice(0, 20);
  const missingStages = data.missingStages.slice(0, 20);
  const workflow = themeWorkflowSchema.parse({
    ...data,
    stages,
    connections,
    duplicateTools,
    missingStages,
    source: 'AI_GENERATED',
    version: 1,
  });
  return { workflow, source: 'ai', model: ai.model };
}

/**
 * 把生成的主线写入新的状态版本。
 * 若已有主线，保留锁定阶段；生成会创建新版本，触发 fork 方案的新版本。
 */
export function saveThemePlan(topicId: string, workflow: ThemeWorkflow, summary = '生成主题主线'): ThemeWorkflow {
  const state = requireCurrentState(topicId);
  const lockedStageIds = new Set((state.workflow?.stages ?? []).filter((stage) => stage.locked).map((stage) => stage.id));
  const mergedStages = workflow.stages.map((stage) => ({
    ...stage,
    locked: lockedStageIds.has(stage.id),
  }));
  const nextWorkflow = themeWorkflowSchema.parse({ ...workflow, stages: mergedStages, version: (state.workflow?.version ?? 0) + 1 });
  const saved = saveNewVersion(topicId, { ...state, workflow: nextWorkflow, consistencyStatus: 'NEEDS_RESEARCH_UPDATE' }, {
    changeSummary: summary,
    createdBy: 'AI_INFERRED',
  });
  getDb().prepare('UPDATE research_topics SET status=?, updated_at=? WHERE id=?').run('PLANNING_THEME', new Date().toISOString(), topicId);
  return saved.workflow as ThemeWorkflow;
}
