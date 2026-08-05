import fs from 'node:fs';
import path from 'node:path';

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const DEFAULT_POLICY = {
  allowedWorkspace: './repo',
  allowHostPackageInstall: false,
  allowSudo: false,
  allowPrivilegedContainers: false,
  allowHostNetwork: false,
  allowDockerSocketMount: false,
  allowHomeDirectoryAccess: false,
  allowCredentialAccess: false,
  allowPush: false,
  maximumCpu: 2,
  maximumMemoryMb: 2048,
  maximumRuntimeSeconds: 1200,
};

function workflowText(bundle, workspaceDir, repoDir, outputDir, inputDir) {
  const plan = bundle.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps.map((s) => `- [${s.type}] ${s.id}${s.command ? `: \`${s.command}\`` : s.dockerfile ? `: ${s.dockerfile}` : ''}`).join('\n') : '（无步骤）';
  return `# 本地功能测试任务

你正在为以下开源项目进行隔离工作区内的本地功能测试。请在工作目录 ${repoDir} 内执行操作，**不要绕过权限限制**。

## 任务
- 仓库：${bundle.repo?.full_name || ''}
- 固定 Commit：${bundle.project?.upstream_commit_sha || 'HEAD'}
- 建议流程（deployment-plan.json，仅作起点，可依据仓库真实情况调整）：
${steps}
- 之前测试与 Agent 接力知识：${Array.isArray(bundle.priorReports) && bundle.priorReports.length > 0 ? `${inputDir}/previous-reports.md` : '无'}

## 目标
    1. 阅读 README、示例、CLI/API 文档、测试配置、源码和目录结构；如存在 ${inputDir}/previous-reports.md，先读取其中经验并以当前固定 Commit 复核，不能把旧结论当成本次证据；
    2. 先建立“用户任务地图”：目标用户是谁、他们要完成什么、输入什么、看到或得到什么结果。不要从 README 目录、命令帮助或技术模块倒推 Case；先从用户任务倒推需要调用的 CLI、API、界面、样例或配置入口；
    3. 围绕用户任务设计不少于 3 个功能 Case：至少包含一个首次成功使用、一个真实日常工作流或多步骤组合、一个错误输入/失败恢复/限制场景。每条 Case 必须有目标用户、使用场景、用户操作、输入数据、预期用户可见结果、实际结果、状态和证据；
    4. 优先验证实际应用功能：使用真实但安全的样例或临时测试数据运行 CLI 命令、库/API 调用、样例、配置、插件/MCP/Agent 能力或服务流程。帮助命令、源码阅读和单元测试只能作为辅助证据，不能成为唯一的“功能通过”结论；不要为了通过校验虚构服务、端口、数据或成功结果；
    5. 部署只服务于功能验证。优先使用官方 Release、包管理器、Compose 或 Dockerfile；若部署失败但存在可安全运行的官方替代入口，继续验证功能。若所有入口都不可用，报告应明确说明“本次没有实际功能验证”，不要用部署分析冒充功能结论；
    6. 缺少依赖、凭据、网络或权限时，先判断是否能使用官方预构建包或工作区内方案。需要工作区依赖或主机级安装/管理员权限时，必须发起第 7 条人工决策；未经对应授权不得执行。记录授权范围、来源、版本和实际影响；
    7. 如确实需要人工决定权限、凭据使用、风险操作、部署方案或测试预期，写入 **${outputDir}/decision-request.json**：
   \`\`\`json
     { "question": "需要确认的具体问题", "options": [{ "id": "allow_host_provisioning", "label": "允许主机安装", "description": "允许使用官方安装器/包管理器，必要时请求管理员权限；会影响本机环境" }, { "id": "allow_workspace_provisioning", "label": "允许隔离依赖", "description": "仅在本任务工作区下载或解压依赖，不修改主机环境" }, { "id": "prepare_and_retry", "label": "暂不安装，保留受限", "description": "本次不安装依赖，任务标记为受限，待环境准备后重试" }, { "id": "skip", "label": "跳过", "description": "保持该 Case 为受限或未验证" }] }
   \`\`\`
    然后等待 **${inputDir}/decision-response.json** 出现，读取用户 choice 和 note 后继续。choice 为 "note" 仅代表用户补充说明，不代表任何权限或授权；应结合 note 继续分析，若仍需授权则以新的 requestId 再次提出明确选项。每次启动或继续时，如该文件已存在，必须先读取并执行其中的 choice；不要重复提出同一问题，也不要在未读取响应前把任务写成失败。不要请求真实密钥或记录凭据。
   7. 可对源码做最小修复（策略见 input/policy.json），记录所有修改；
   8. 完成后必须写入 **${outputDir}/result.json**（绝对路径）：
   \`\`\`json
    { "status": "passed|failed", "port": <可选端口号>, "summary": "测试结论", "notes": "关键证据与限制" }
   \`\`\`
    9. 必须生成面向用户的中文 **${outputDir}/report.md**。报告正文先讲实际功能和使用方式，部署与命令细节放在后面。没有信息时明确写“未执行”或“无”，不要输出隐藏推理过程：
   \`\`\`markdown
    # 项目功能测试报告
     ## 1. 值不值得用
     ## 2. 它如何帮助用户
     ## 3. 真实项目示例
     ## 4. 核心体验验证
     ## 5. 适合与不适合的场景
    ## 6. 安装与部署摘要
    ## 7. 限制与未验证内容
    ## 8. 给下一个 Agent 的经验
    ## 9. 证据附录
    \`\`\`
    报告必须至少包含：项目给用户带来的实际价值、它通过哪些规则/库/架构或集成机制实现、适合和不适合什么项目；一个贴近该项目的完整使用例子，说明用户如何把它用进自己的项目。对于编程工具或 Skill，例子可使用“开发贪吃蛇小游戏”等小型真实项目，但只有与该工具适用范围相符时才可采用；明确工具在该流程中做了什么、用户会看到什么变化、收益是否已实测。不得把未经测量的 token、成本或速度节省写成事实。
    “核心体验验证”最多列出 3 个用户可感知的体验结论。将模式、参数、适配器和内部测试合并为支撑同一体验的证据，不要把每个技术变量拆成独立 Case。每项体验都应说明用户任务、实际结果、用户意味着什么和关键证据。安装与部署摘要只需说明采用什么方式、是否成功、失败原因和如何启动/停止；完整命令、退出码、日志/产物路径统一放入“证据附录”。“给下一个 Agent 的经验”只记录可复用事实、阻塞根因和下一步，不记录密钥、令牌、用户数据或隐藏推理。
    10. 同时生成独立的用户使用说明 **${outputDir}/USAGE_GUIDE.md**。它必须可以脱离报告阅读，包含：工具是什么、最适合的项目、最小安装/启用步骤、一个具体项目中的使用示例、预期收益与边界、常见误用。不要复制内部 Case 参数或完整日志。
   如有修改，再生成 ${outputDir}/patch.diff。
    10. 未获得主机授权时，不得执行管理员安装、修改系统 PATH 或主机级软件变更；获得 allow_host_provisioning 后，才可使用官方来源执行必要的主机安装，并在报告中记录授权、来源、版本和变更。任何情况下都不要访问用户主目录、挂载 Docker Socket 或记录真实凭据。

## 验证
Runner 会检查 result.json 与 report.md。仅当建议流程明确包含 http_check 且 result.json 提供端口时，才会额外进行 HTTP 探测。status 必须为 passed 才算成功。
`;
}

export function writeBundle(bundle, workspaceDir) {
  const inputDir = path.join(workspaceDir, 'input');
  const instructionsDir = path.join(workspaceDir, 'instructions');
  const outputDir = path.join(workspaceDir, 'output');
  const repoDir = path.join(workspaceDir, 'repo');

  writeJson(path.join(inputDir, 'task.json'), bundle.task);
  writeJson(path.join(inputDir, 'assessment.json'), bundle.assessment ?? {});
  writeJson(path.join(inputDir, 'deployment-plan.json'), bundle.plan ?? {});
  const priorReports = Array.isArray(bundle.priorReports) ? bundle.priorReports : [];
  const priorReportsText = priorReports.map((report, index) => [
    `# 历史测试报告 ${index + 1}`,
    `- 任务：${String(report.task_id ?? '未知')}`,
    `- 状态：${String(report.status ?? '未知')}`,
    `- 更新时间：${String(report.updated_at ?? '未知')}`,
    '',
    String(report.report_markdown ?? '').slice(0, 20_000),
    '',
  ].join('\n')).join('\n');
  if (priorReportsText) fs.writeFileSync(path.join(inputDir, 'previous-reports.md'), priorReportsText, 'utf8');
  writeJson(path.join(inputDir, 'policy.json'), {
    ...DEFAULT_POLICY,
    allowModification: bundle.task?.allow_modification === 1,
    allowCommit: bundle.task?.allow_commit === 1,
  });
  writeJson(path.join(inputDir, 'environment.json'), {
    cpu: bundle.plan?.estimatedResources?.cpu ?? 2,
    memoryMb: bundle.plan?.estimatedResources?.memoryMb ?? 2048,
    diskMb: bundle.plan?.estimatedResources?.diskMb ?? 2048,
    gpuRequired: bundle.plan?.estimatedResources?.gpuRequired ?? false,
  });
  fs.mkdirSync(instructionsDir, { recursive: true });
  fs.writeFileSync(path.join(instructionsDir, 'DEPLOYMENT_WORKFLOW.md'), workflowText(bundle, workspaceDir, repoDir, outputDir, inputDir), 'utf8');
  fs.writeFileSync(path.join(inputDir, 'verification.yaml'), [
    'projectType: local-exploratory',
    '',
    'checks:',
    '  - id: agent-result',
    '    type: result_json',
    '    required: true',
    '',
    '  - id: test-report',
    '    type: report_markdown',
    '    required: true',
    '',
    'artifacts:',
    '  collect:',
    '    - stdout',
    '    - stderr',
     '    - report.md',
     '    - USAGE_GUIDE.md',
     '    - result.json',
    '    - patch.diff',
    '',
  ].join('\n'), 'utf8');
  fs.mkdirSync(outputDir, { recursive: true });

  return { inputDir, instructionsDir, outputDir, repoDir };
}
