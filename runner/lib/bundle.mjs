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

function workflowText(bundle, workspaceDir, repoDir, outputDir) {
  const plan = bundle.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps.map((s) => `- [${s.type}] ${s.id}${s.command ? `: \`${s.command}\`` : s.dockerfile ? `: ${s.dockerfile}` : ''}`).join('\n') : '（无步骤）';
  return `# 本地功能测试任务

你正在为以下开源项目进行隔离工作区内的本地功能测试。请在工作目录 ${repoDir} 内执行操作，**不要绕过权限限制**。

## 任务
- 仓库：${bundle.repo?.full_name || ''}
- 固定 Commit：${bundle.project?.upstream_commit_sha || 'HEAD'}
- 建议流程（deployment-plan.json，仅作起点，可依据仓库真实情况调整）：
${steps}

## 目标
1. 阅读 README、测试配置、构建脚本和源码，选择适合该项目类型的本地验证方式；
2. 尽量测试真实功能：优先运行已有测试；并按项目类型验证 CLI 命令、库调用、构建产物、样例、MCP/Agent 能力或安全可启动的服务。不要为了通过校验而虚构 HTTP 服务或端口；
3. 可对源码做最小修复（策略见 input/policy.json），记录所有修改；
4. 完成后必须写入 **${outputDir}/result.json**（绝对路径）：
   \`\`\`json
    { "status": "passed|failed", "port": <可选端口号>, "summary": "测试结论", "notes": "关键证据与限制" }
   \`\`\`
5. 必须生成中文 **${outputDir}/report.md**，使用下面的固定结构。没有信息时明确写“未执行”或“无”。不要输出隐藏推理过程，只记录可审计的命令、结果和修改：
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
   \`\`\`
   如有修改，再生成 ${outputDir}/patch.diff。
6. 不要执行 sudo、不要挂载 Docker Socket、不要访问用户主目录、不要注入真实凭据。

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
  fs.writeFileSync(path.join(instructionsDir, 'DEPLOYMENT_WORKFLOW.md'), workflowText(bundle, workspaceDir, repoDir, outputDir), 'utf8');
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
