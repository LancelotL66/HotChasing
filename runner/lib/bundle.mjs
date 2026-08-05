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
   1. 阅读 README、测试配置、构建脚本和源码；如存在 ${inputDir}/previous-reports.md，先读取其中已验证命令、已知限制与后续建议，并以当前固定 Commit 的实际结果复核，不能把旧结论直接当作本次证据；
   2. 按仓库正常流程完成部署：优先使用官方 Compose、Dockerfile、Release 或包管理器脚本，不要为了测试另造部署方式；
   3. 先根据 README、源码和已发现能力自主设计不少于 3 个可执行的功能 Case。每个 Case 都必须包含目标、前置条件、输入或操作、预期结果与可审计的验证方式；优先覆盖核心主路径、边界/异常或降级路径，以及一个端到端工作流；
   4. 执行这些 Case：优先运行已有测试，并补充多项真实功能验证，例如 CLI 命令、库调用、构建产物、样例、MCP/Agent 能力或安全可启动的服务。不要为了通过校验而虚构 HTTP 服务、端口、数据或成功结果；
   5. 受凭据、外部服务、硬件、网络或安全策略限制而无法执行的 Case，不得标记为通过，必须记录阻塞条件、已尝试的安全替代验证和恢复执行所需条件；
   6. 如确实需要人工决定权限、凭据使用、风险操作、部署方案或测试预期，写入 **${outputDir}/decision-request.json**：
   \`\`\`json
   { "question": "需要确认的具体问题", "options": [{ "id": "allow_once", "label": "允许一次", "description": "影响说明" }, { "id": "skip", "label": "跳过", "description": "影响说明" }] }
   \`\`\`
   然后等待 **${inputDir}/decision-response.json** 出现，读取用户 choice 和 note 后继续。不要因可安全询问的问题直接失败；不要请求真实密钥或用户主目录访问。
   7. 可对源码做最小修复（策略见 input/policy.json），记录所有修改；
   8. 完成后必须写入 **${outputDir}/result.json**（绝对路径）：
   \`\`\`json
    { "status": "passed|failed", "port": <可选端口号>, "summary": "测试结论", "notes": "关键证据与限制" }
   \`\`\`
   9. 必须生成详细中文 **${outputDir}/report.md**，使用下面的固定结构。没有信息时明确写“未执行”或“无”。不要输出隐藏推理过程，只记录可审计的命令、结果和修改：
   \`\`\`markdown
   # 项目本地部署测试报告
   ## 1. 最终结论
   ## 2. 项目与测试版本
   ## 3. AI 初始部署分析
   ## 4. 实际采用的部署方案
   ## 5. 构建结果
   ## 6. 启动结果
   ## 7. 功能验证结果
   ## 8. Agent 修复过程
   ## 9. 修改文件
   ## 10. 本地部署信息
   ## 11. 资源使用
   ## 12. 风险与阻塞
   ## 13. 已验证内容
   ## 14. 未验证内容
    ## 15. 后续建议
    ## 16. 用户功能与使用指南
    ## 17. Agent 接力知识
    \`\`\`
   报告必须至少包含：Case 总数、通过/失败/跳过数量和最终结论；逐条列出 Case ID、名称、类型、前置条件、输入或步骤、预期结果、实际结果、状态和证据位置；记录每条关键命令、退出码、关键输出摘要和日志/产物路径；说明服务地址、端口、健康检查结果和停止方式；说明修改文件用途、未覆盖项的具体原因及后续建议。
   “用户功能与使用指南”必须面向实际使用者，说明项目解决的问题、已通过本次 Case 验证的关键能力、安装/启动方式、至少两个典型使用流程、关键输入输出/配置项、可复制的最小示例，以及限制与适用边界。不得将 README 未验证的能力写成已可用功能。
   “Agent 接力知识”必须面向下一位 Agent，使用短条目记录：本次固定 Commit、成功命令与所需环境、通过/失败的 Case、已知阻塞和根因、未完成项、可安全继续的下一步、需要人工确认的条件。不得记录密钥、令牌、用户数据或隐藏推理过程。
   如有修改，再生成 ${outputDir}/patch.diff。
   10. 不要执行 sudo、不要挂载 Docker Socket、不要访问用户主目录、不要注入真实凭据。

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
    '    - result.json',
    '    - patch.diff',
    '',
  ].join('\n'), 'utf8');
  fs.mkdirSync(outputDir, { recursive: true });

  return { inputDir, instructionsDir, outputDir, repoDir };
}
