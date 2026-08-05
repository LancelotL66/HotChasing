import fs from 'node:fs';
import path from 'node:path';

const verified = new Set(['VERIFIED_LOCAL', 'VERIFIED_SANDBOX', 'PARTIALLY_VERIFIED']);
const labels = { KEEP_LONG_TERM: '值得长期保留', WORTH_TRYING: '值得试用', CONDITIONAL_USE: '有条件使用', NICHE_USE_ONLY: '仅适合特定场景', WATCH_ONLY: '建议继续观察', NOT_WORTH_DEPLOYING: '不建议本地部署', UNSAFE: '不安全，未执行' };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function row(values) { return `| ${values.map((value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ')} |`; }
function list(items, empty = '无') { return items.length ? items.map((item) => `- ${item}`).join('\n') : `- ${empty}`; }

export function generateUserReport({ taskId, outputDir, inputDir, fallbackResult, startedAt }) {
  const finishedAt = new Date().toISOString();
  const technicalDir = path.join(outputDir, 'technical');
  fs.mkdirSync(technicalDir, { recursive: true });
  const legacy = fallbackResult ?? readJson(path.join(outputDir, 'result.json'), {});
  const execution = readJson(path.join(technicalDir, 'execution-result.json'), {
    schemaVersion: 1, taskId,
    deployment: { status: legacy?.status === 'passed' ? 'SUCCESS' : 'FAILED', summary: legacy?.summary || '未提供部署结果。' },
    startup: { status: legacy?.status === 'passed' ? 'SUCCESS' : 'NOT_ATTEMPTED', summary: legacy?.notes || '未单独验证启动。' },
    coreWorkflow: { status: 'NOT_TESTED', summary: '没有可验证的核心用户旅程证据。' },
    testSuite: { status: legacy?.status === 'passed' ? 'PARTIAL' : 'NOT_ATTEMPTED', summary: '未提供结构化测试套件结果。' },
    overallVerification: { status: legacy?.status === 'passed' ? 'PARTIALLY_VERIFIED' : 'NOT_VERIFIED' }, startedAt: startedAt || finishedAt, finishedAt,
  });
  const matrix = readJson(path.join(outputDir, 'capability-matrix.json'), { schemaVersion: 1, capabilities: [] });
  const playbook = readJson(path.join(outputDir, 'usage-playbook.json'), { schemaVersion: 1, representativeExample: { title: '项目核心使用场景', userGoal: '完成项目的主要用户任务', projectContext: '根据仓库文档和入口确定', steps: [], userVisibleResult: '未验证', verificationStatus: 'NOT_TESTED' }, firstTimeSetup: { prerequisites: [], steps: [] }, dailyWorkflows: [], advancedWorkflows: [], stopAndRemove: { stopSteps: [], dataLocations: [], cleanupSteps: [] } });
  const profile = readJson(path.join(inputDir, 'project-profile.json'), {});
  const coreVerified = matrix.capabilities?.some((item) => item.importance === 'CORE' && verified.has(item.verificationStatus));
  const value = coreVerified ? 'WORTH_TRYING' : execution.deployment.status === 'SUCCESS' ? 'CONDITIONAL_USE' : 'WATCH_ONLY';
  const confidence = coreVerified ? 'MOSTLY_VERIFIED' : 'PARTIALLY_VERIFIED';
  const capabilities = Array.isArray(matrix.capabilities) ? matrix.capabilities : [];
  const grouped = (statuses) => capabilities.filter((item) => statuses.includes(item.verificationStatus)).map((item) => item.name);
  const report = {
    schemaVersion: 1,
    verdict: { deploymentValue: value, label: labels[value], confidence, summary: coreVerified ? '至少一个核心用户旅程已在本地获得证据。' : '基础部署结果已收集，但核心用户旅程尚未完整验证。', keepRecommendation: coreVerified ? '建议保留，并在实际项目中继续验证。' : '建议仅为后续核心功能验证保留，暂不替代现有工具。' },
    bestFor: profile.targetUsers || [], notFor: coreVerified ? [] : ['需要立即确认核心功能可用的用户'], userProblemsSolved: capabilities.map((item) => item.userValue), usageSummary: playbook.dailyWorkflows.map((item) => item.title), featureTable: capabilities, deploymentCostTable: [], comparisonTable: [], mainAdvantages: grouped(['VERIFIED_LOCAL', 'VERIFIED_SANDBOX']), mainLimitations: [...grouped(['NOT_TESTED', 'BLOCKED', 'FAILED']), ...capabilities.flatMap((item) => item.limitations || [])], verifiedCapabilities: grouped(['VERIFIED_LOCAL', 'VERIFIED_SANDBOX']), documentationOnlyCapabilities: grouped(['DOCUMENTATION_ONLY', 'INFERRED']), untestedCapabilities: grouped(['NOT_TESTED', 'BLOCKED']), failedCapabilities: grouped(['FAILED']), chooseThisWhen: coreVerified ? ['需要与本次已验证用户旅程相同的工作流'] : [], chooseAlternativesWhen: coreVerified ? [] : ['无法满足本次未验证核心能力所需条件'], nextActions: coreVerified ? ['在真实项目中复测关键工作流'] : ['准备缺失条件后重测核心用户旅程'],
  };
  const featureRows = capabilities.map((item) => row([item.name, item.userValue, item.verificationStatus, item.experience, (item.limitations || []).join('；')])).join('\n') || row(['无已收集功能证据', '—', 'NOT_TESTED', '—', '—']);
  const setupRows = (playbook.firstTimeSetup?.steps || []).map((item) => row([item.title, item.command || '按官方文档执行', item.expectedResult, item.verificationStatus])).join('\n') || row(['准备运行环境', '按官方文档执行', '具备测试前提', 'DOCUMENTATION_ONLY']);
  const workflowRows = (playbook.dailyWorkflows || []).map((item) => row([item.title, item.steps.join(' -> '), item.expectedOutcome, item.verificationStatus])).join('\n') || row(['核心日常工作流', '未收集', '未验证', 'NOT_TESTED']);
  const example = playbook.representativeExample || { title: '项目核心使用场景', userGoal: '完成项目的主要用户任务', projectContext: '根据仓库文档和入口确定', steps: [], userVisibleResult: '未验证', verificationStatus: 'NOT_TESTED' };
  const markdown = `# 项目本地使用评估报告

## 1. 结论摘要
| 项目 | 结论 |
|---|---|
${row(['部署价值', report.verdict.label])}
${row(['主要价值', report.verdict.summary])}
${row(['核心限制', report.mainLimitations.join('；') || '核心用户旅程仍需继续验证'])}
${row(['本地测试结果', execution.overallVerification.status])}
${row(['是否建议保留', report.verdict.keepRecommendation])}
${row(['报告可信程度', confidence])}

## 2. 是否值得部署
${report.verdict.summary} ${!coreVerified ? '构建或启动成功不等同于核心功能成功，本报告未将其作为整体通过结论。' : ''}

## 3. 适合谁，不适合谁
| 适合 | 不适合 |
|---|---|
${row([report.bestFor.join('；') || '需要进一步评估该项目的用户', report.notFor.join('；') || '无明确排除对象'])}

## 4. 它能解决什么问题
| 用户需求 | 项目提供的能力 | 验证情况 | 对用户的意义 |
|---|---|---|---|
${capabilities.map((item) => row([item.userValue, item.name, item.verificationStatus, item.experience])).join('\n') || row(['尚未形成实际功能证据', '—', 'NOT_TESTED', '需补充核心测试'])}

## 5. 用户具体如何使用
### 代表性使用示例：${example.title}
**用户目标**：${example.userGoal}

**项目上下文**：${example.projectContext}

**操作步骤**：
${list(example.steps)}

**用户可见结果**：${example.userVisibleResult}

**本次验证**：${example.verificationStatus}

### 第一次使用
| 步骤 | 用户操作 | 预期结果 | 验证情况 |
|---|---|---|---|
${setupRows}

### 日常使用
| 使用场景 | 操作方式 | 预期结果 | 本次验证 |
|---|---|---|---|
${workflowRows}

## 6. 核心功能表现
| 功能 | 用户价值 | 实测状态 | 体验评价 | 主要限制 |
|---|---|---|---|---|
${featureRows}

## 7. 本地部署和维护成本
| 成本项 | 实际情况 | 对用户的影响 |
|---|---|
${row(['初次安装', execution.deployment.summary, '以技术报告和实际环境为准'])}
${row(['账号和凭据', '未读取真实凭据', '受外部 Provider 限制的功能需要用户自行准备'])}
${row(['网络和权限', '遵守任务策略和人工授权', '未获授权不会修改主机环境'])}

## 8. 与其他类型工具比较
| 维度 | 当前项目 | 常见替代方案 | 用户意味着什么 | 依据 |
|---|---|---|---|---|
${row(['使用方式', profile.productForm?.join('/') || '待确认', '同类 CLI、图形界面或托管服务', '按工作流偏好选择', 'CATEGORY_COMPARISON'])}
本次没有进行同一任务的直接竞品比较，无法判断代码质量、性能、稳定性或成本优劣。

## 9. 主要优势
${list(report.mainAdvantages, '尚无足够本地证据')}

## 10. 主要不足
${list(report.mainLimitations, '无')}

## 11. 已验证与未验证
### 已实际验证
${list(report.verifiedCapabilities)}
### 仅文档支持
${list(report.documentationOnlyCapabilities)}
### 未验证
${list(report.untestedCapabilities)}
### 实际失败
${list(report.failedCapabilities)}

## 12. 选择建议
| 选择当前项目，当你…… | 选择其他方案，当你…… |
|---|---|
${row([report.chooseThisWhen.join('；') || '完成缺失验证后再决定', report.chooseAlternativesWhen.join('；') || '需要不同交互方式或已验证的替代能力'])}

## 13. 下一步建议
${list(report.nextActions)}

<details><summary>技术测试摘要</summary>

部署：${execution.deployment.status}，${execution.deployment.summary}

启动：${execution.startup.status}，${execution.startup.summary}

核心流程：${execution.coreWorkflow.status}，${execution.coreWorkflow.summary}

完整技术证据见 \`technical/TECHNICAL_REPORT.md\` 与 \`technical/\`。
</details>
`;
  writeJson(path.join(outputDir, 'user-report.json'), report);
  fs.writeFileSync(path.join(outputDir, 'USER_REPORT.md'), markdown, 'utf8');
  return { report, markdown, execution };
}
