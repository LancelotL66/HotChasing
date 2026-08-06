import {
  changeOperationSchema,
  interpretationOutputSchema,
  type ChangeOperation,
  type InterpretationOutput,
} from '../state/researchOperations.js';
import type { ResearchState } from '../state/researchStateSchema.js';
import { requestResearchJson } from '../ai/researchAi.js';

/**
 * 把用户自然语言消息解释为结构化变更操作。
 *
 * 原则：
 * - 只针对当前 Research State 生成变更，不从完整聊天记录重新猜测；
 * - AI 不可用时用关键词规则兜底，无法识别时返回 needsClarification 而不是瞎猜；
 * - 解释器不写数据库，返回结果由提案服务保存。
 */

function findStageByText(state: ResearchState, text: string) {
  return state.stages.find((stage) => text.includes(stage.name))
    ?? state.stages.find((stage) => stage.id.length > 2 && text.toLowerCase().includes(stage.id.toLowerCase()));
}

const LANGUAGE_KEYWORDS: Array<[RegExp, string]> = [
  [/python/i, 'Python'],
  [/typescript/i, 'TypeScript'],
  [/javascript|node/i, 'JavaScript'],
  [/rust/i, 'Rust'],
  [/\bgo\b|golang/i, 'Go'],
  [/java\b/i, 'Java'],
  [/c\+\+/i, 'C++'],
];

/** 规则兜底解释器：覆盖方案中列出的高频指令。 */
export function interpretByRules(state: ResearchState, message: string): InterpretationOutput {
  const text = message.trim();
  const operations: ChangeOperation[] = [];
  const bullets: string[] = [];
  const assumptions: string[] = [];

  // 只保留某种语言
  const onlyLanguage = /只(保留|要|用|使用)\s*([A-Za-z+#.]+)/.exec(text);
  if (onlyLanguage) {
    const matched = LANGUAGE_KEYWORDS.find(([pattern]) => pattern.test(onlyLanguage[2]));
    if (matched) {
      operations.push({ type: 'UPDATE_REQUIREMENT', patch: { languages: [matched[1]] } });
      bullets.push(`语言约束收紧为仅 ${matched[1]}`);
    }
  }

  // GPU / 付费 API 约束
  if (/不(要|想|使用|需要).{0,6}gpu|排除.{0,4}gpu|无\s?gpu|cpu\s?only/i.test(text)) {
    operations.push({ type: 'UPDATE_REQUIREMENT', patch: { gpuAllowed: false } });
    bullets.push('排除需要 GPU 的工具');
  }
  if (/不(要|想|使用).{0,6}(付费|收费).{0,6}(api)?|免费/i.test(text)) {
    operations.push({ type: 'UPDATE_REQUIREMENT', patch: { paidApiAllowed: false } });
    bullets.push('排除依赖付费 API 的工具');
  }
  if (/本地|离线/.test(text) && /运行|部署/.test(text)) {
    operations.push({ type: 'UPDATE_REQUIREMENT', patch: { localDeploymentPreferred: true } });
    bullets.push('优先可本地运行的工具');
  }

  // 删除环节
  const deleteMatch = /(删除|去掉|移除|不要)\s*([\u4e00-\u9fa5A-Za-z0-9 ]{2,20}?)\s*(环节|阶段|步骤)?$/.exec(text);
  if (/删除|去掉|移除/.test(text)) {
    const stage = findStageByText(state, text);
    if (stage) {
      operations.push({ type: 'DELETE_STAGE', stageId: stage.id });
      bullets.push(`删除研究环节「${stage.name}」`);
    } else if (deleteMatch) {
      assumptions.push(`未找到名为「${deleteMatch[2]}」的研究环节，未执行删除。`);
    }
  }

  // 新增环节
  const addMatch = /(增加|新增|添加|加上)\s*([\u4e00-\u9fa5A-Za-z0-9 ]{2,20}?)\s*(环节|阶段|步骤)/.exec(text);
  if (addMatch) {
    const name = addMatch[2].trim();
    const exists = state.stages.some((stage) => stage.name === name);
    if (!exists) {
      const after = /在\s*([\u4e00-\u9fa5A-Za-z0-9 ]{2,20}?)\s*(之后|后面)/.exec(text);
      const anchor = after ? findStageByText(state, after[1]) : undefined;
      operations.push({
        type: 'ADD_STAGE',
        name,
        description: '',
        required: true,
        inputs: [],
        outputs: [],
        keywords: [],
        ...(anchor ? { positionAfter: anchor.id } : {}),
      } as ChangeOperation);
      bullets.push(`新增研究环节「${name}」${anchor ? `，放在「${anchor.name}」之后` : ''}`);
    }
  }

  // 多找一些候选
  if (/多找|再找|更多候选|增加候选/.test(text)) {
    const stage = findStageByText(state, text) ?? state.stages[0];
    if (stage) {
      operations.push({
        type: 'ADD_TOOL_CONSTRAINT',
        stageId: stage.id,
        constraint: { minimumCandidates: Math.min(120, (stage.toolRequirements.minimumCandidates || 10) * 2) },
      });
      bullets.push(`扩大「${stage.name}」的候选数量下限`);
    }
  }

  // 只要库、不要平台
  if (/只要(库|library)|不要平台|不要平台型/.test(text)) {
    const stage = findStageByText(state, text) ?? state.stages[0];
    if (stage) {
      operations.push({ type: 'ADD_TOOL_CONSTRAINT', stageId: stage.id, constraint: { allowedProductForms: ['LIBRARY', 'CLI'] } });
      operations.push({ type: 'UPDATE_REQUIREMENT', patch: { excludedProductForms: ['PLATFORM', 'WEB_APP'] } });
      bullets.push(`「${stage.name}」只保留库与 CLI 形态`);
    }
  }

  // 修改测试范围
  const testGoal = /(测试目标|验证目标)(是|为|：|:)\s*(.+)$/.exec(text);
  if (testGoal) {
    operations.push({ type: 'UPDATE_TEST_SCOPE', testGoal: testGoal[3].slice(0, 400) });
    bullets.push('更新端到端测试目标');
  }

  const needsClarification = operations.length === 0;
  return interpretationOutputSchema.parse({
    intent: operations.length === 0
      ? 'UNKNOWN'
      : operations.length > 1 && new Set(operations.map((operation) => operation.type)).size > 1
        ? 'MIXED'
        : operations[0].type.includes('STAGE')
          ? 'ADJUST_RESEARCH_STAGES'
          : operations[0].type === 'UPDATE_REQUIREMENT'
            ? 'ADJUST_CONSTRAINTS'
            : operations[0].type === 'UPDATE_TEST_SCOPE'
              ? 'ADJUST_TEST_SCOPE'
              : 'ADJUST_TOOLS',
    summary: needsClarification ? '未能从当前消息中识别出明确的结构化调整。' : bullets.join('；'),
    bullets,
    operations,
    assumptions: needsClarification ? [] : ['本次调整由关键词规则解析，AI 深度理解不可用。', ...assumptions],
    warnings: [],
    needsClarification,
    clarificationQuestion: needsClarification ? '请更具体地说明要调整的研究环节、约束或工具，例如「删除实验追踪环节」或「只保留 Python 工具」。' : '',
  });
}

function stateSummary(state: ResearchState): string {
  const stages = state.stages
    .map((stage) => `- ${stage.id}｜${stage.name}｜${stage.required ? '必选' : '可选'}｜锁定=${stage.locked}｜已选工具=${stage.selectedToolIds.length}`)
    .join('\n');
  const tools = state.selectedTools
    .filter((tool) => tool.status !== 'REMOVED_BY_USER')
    .map((tool) => `- ${tool.githubNodeId}｜${tool.fullName}｜环节=${tool.stageId || '未分配'}｜${tool.selectionRole}｜锁定=${tool.locked}`)
    .join('\n');
  const workflow = state.workflow
    ? state.workflow.stages.map((stage) => `- ${stage.id}｜${stage.name}｜工具=${stage.toolIds.join(',') || '无'}｜锁定=${stage.locked}`).join('\n')
    : '（尚未生成主线）';
  return `研究主题：${state.title}
研究目标：${state.objective || '未填写'}
当前状态版本：v${state.version}
约束：语言=${state.requirements.languages.join('/') || '不限'}；平台=${state.requirements.platforms.join('/') || '不限'}；本地优先=${state.requirements.localDeploymentPreferred}；允许 GPU=${state.requirements.gpuAllowed}；允许付费 API=${state.requirements.paidApiAllowed}；排除形态=${state.requirements.excludedProductForms.join('/') || '无'}
锁定字段：${Object.keys(state.locks).filter((key) => state.locks[key]).join('、') || '无'}
研究环节：
${stages || '（暂无）'}
已选工具：
${tools || '（暂无）'}
主题主线：
${workflow}
未解决问题：${state.unresolvedIssues.join('；') || '无'}`;
}

const OPERATION_REFERENCE = `可用操作类型（type）与关键字段：
UPDATE_OBJECTIVE{objective,title?}
UPDATE_REQUIREMENT{patch:{domains?,languages?,platforms?,preferredExecution?,localDeploymentPreferred?,gpuAllowed?,paidApiAllowed?,externalNetworkAllowed?,licenseRequired?,excludedProductForms?,extraConstraints?}}
ADD_STAGE{temporaryId?,name,description,required,inputs,outputs,keywords,positionAfter?,positionBefore?}
UPDATE_STAGE{stageId,name?,description?,inputs?,outputs?}
DELETE_STAGE{stageId}
REORDER_STAGE{stageOrder:[stageId...]}
SPLIT_STAGE{stageId,parts:[{name,description,keywords}]}
MERGE_STAGES{stageIds:[...],name?}
LOCK_FIELD{path}
UNLOCK_FIELD{path}
MARK_STAGE_REQUIRED{stageId}
MARK_STAGE_OPTIONAL{stageId}
ADD_TOOL_CONSTRAINT{stageId,constraint:{languages?,minimumCandidates?,localDeploymentPreferred?,gpuAllowed?,allowedProductForms?,keywords?}}
REMOVE_TOOL_CONSTRAINT{stageId,fields:[...]}
SELECT_TOOL{githubNodeId,fullName,stageId,role?,selectionRole,acquisitionMode?,notes}
REMOVE_TOOL{githubNodeId,reason}
CHANGE_PRIMARY_TOOL{stageId,githubNodeId}
ADD_ALTERNATIVE_TOOL{githubNodeId,fullName,stageId,role?,acquisitionMode?}
REPLACE_TOOL{githubNodeId,replacementGithubNodeId,replacementFullName,stageId?,role?,acquisitionMode?}
UPDATE_WORKFLOW{patch:{name?,description?,testGoal?,themeInputs?,finalOutputs?,stageOrder?,removeStageIds?,successCriteria?,connections?,stagePatches?}}
UPDATE_TEST_SCOPE{testGoal?,successCriteria?}`;

export async function interpretUserMessage(state: ResearchState, message: string, pageContext = ''): Promise<{ output: InterpretationOutput; source: 'ai' | 'rule' }> {
  const fallback = interpretByRules(state, message);
  const prompt = `你是主题研究状态维护助手。把用户消息转换为结构化变更操作。

硬性规则：
1. 只针对下面给出的当前研究状态生成变更，不要引入状态中不存在的环节 ID 或工具 ID；
2. 不得新增用户没有要求的 GitHub 仓库；需要补充工具时只写入 warnings 建议；
3. 被标记为锁定的字段、环节、工具或主线阶段不得修改，必要时在 warnings 中说明；
4. 用户意图不明确时把 needsClarification 设为 true，并给出一个澄清问题，operations 留空；
5. bullets 用中文列出你的理解，逐条对应实际操作；
6. 只返回 JSON，字段：intent,summary,bullets,operations,assumptions,warnings,needsClarification,clarificationQuestion；
7. intent 只能取：ADJUST_RESEARCH_OBJECTIVE,ADJUST_RESEARCH_STAGES,ADJUST_CONSTRAINTS,ADJUST_TOOLS,ADJUST_WORKFLOW,ADJUST_TEST_SCOPE,MIXED,UNKNOWN。

${OPERATION_REFERENCE}

当前研究状态：
${stateSummary(state)}

${pageContext ? `当前页面上下文：${pageContext}\n` : ''}用户消息：
${message.slice(0, 2000)}`;

  const ai = await requestResearchJson('change-interpreter', interpretationOutputSchema, prompt, 2000, 0.1);
  if (!ai.data) return { output: fallback, source: 'rule' };
  // 过滤掉引用了不存在环节 / 工具的操作，避免把错误引用写进提案。
  const stageIds = new Set(state.stages.map((stage) => stage.id));
  const toolIds = new Set(state.selectedTools.map((tool) => tool.githubNodeId));
  const warnings = [...ai.data.warnings];
  const operations = ai.data.operations.filter((operation) => {
    const parsed = changeOperationSchema.safeParse(operation);
    if (!parsed.success) { warnings.push('已忽略一条格式不合规的变更操作。'); return false; }
    const item = parsed.data;
    if ('stageId' in item && item.stageId && !stageIds.has(item.stageId)) {
      warnings.push(`已忽略引用不存在研究环节 ${item.stageId} 的操作。`);
      return false;
    }
    if (item.type === 'REMOVE_TOOL' || item.type === 'CHANGE_PRIMARY_TOOL' || item.type === 'REPLACE_TOOL') {
      if (!toolIds.has(item.githubNodeId)) {
        warnings.push('已忽略引用不存在工具的操作。');
        return false;
      }
    }
    if (item.type === 'MERGE_STAGES' && item.stageIds.some((id) => !stageIds.has(id))) {
      warnings.push('已忽略引用不存在研究环节的合并操作。');
      return false;
    }
    if (item.type === 'REORDER_STAGE' && item.stageOrder.every((id) => !stageIds.has(id))) {
      warnings.push('已忽略无效的排序操作。');
      return false;
    }
    return true;
  });
  return {
    output: interpretationOutputSchema.parse({
      ...ai.data,
      operations,
      warnings,
      needsClarification: ai.data.needsClarification || operations.length === 0,
    }),
    source: 'ai',
  };
}
