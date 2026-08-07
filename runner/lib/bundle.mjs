import fs from 'node:fs';
import path from 'node:path';

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function boolEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

const DEFAULT_POLICY = {
  schemaVersion: 1, allowedWorkspace: './repo', allowHostPackageInstall: false, allowWorkspaceToolchain: boolEnv('POLICY_ALLOW_WORKSPACE_TOOLCHAIN', false) ? true : 'ASK',
  allowSudo: false, allowPrivilegedContainers: false, allowHostNetwork: false, allowDockerSocketMount: false,
  allowHomeDirectoryAccess: false, allowCredentialAccess: false, allowExternalProvider: boolEnv('POLICY_ALLOW_EXTERNAL_PROVIDER', false) ? true : 'ASK', allowPush: false,
  maximumCpu: 2, maximumMemoryMb: 2048, maximumRuntimeSeconds: 1200,
};

function projectType(bundle) {
  const language = String(bundle.repo?.language || '').toLowerCase();
  const text = `${bundle.repo?.description || ''} ${bundle.repo?.topics || ''}`.toLowerCase();
  if (/agent|llm|ai /.test(text)) return 'AI_AGENT';
  if (/mcp/.test(text)) return 'MCP_SERVER';
  if (/cli|command.line/.test(text)) return 'CLI';
  if (['go', 'rust'].includes(language)) return 'DEVELOPER_TOOL';
  return 'UNKNOWN';
}

function taskInstructions({ repoDir, outputDir, packageDir }) {
  return `# HotChasing Local Test Task

## 任务目标
在隔离工作区 ${repoDir} 内，依据任务包完成本地部署和用户功能测试。核心用户旅程优先于构建、帮助命令和单元测试；构建成功不代表核心功能可用。

## 必读文件
1. ${packageDir}/task.json
2. ${packageDir}/project-profile.json
3. ${packageDir}/initial-assessment.json
4. ${packageDir}/deployment-plan.json
5. ${packageDir}/test-plan.json
6. ${packageDir}/policy.json
7. ${packageDir}/environment.json
8. ${packageDir}/verification.yaml

## 工作原则
- 只修改 repo/ 内的文件；不访问用户 Home、真实凭据或 Docker Socket；不使用 sudo、privileged、Push。
- 先用用户目标倒推测试：至少覆盖首次使用、核心日常工作流、错误或受限场景。
- 未验证能力必须标为 NOT_TESTED、DOCUMENTATION_ONLY 或 BLOCKED；不得将帮助命令、HTTP 200 或构建成功写成核心功能成功。
- 工作区工具链、外部 Provider 或风险操作必须先写入 ${outputDir}/decisions/decision-requests/<request-id>.json 并等待 input/decision-response.json；不得记录真实密钥。

## 必须输出
- technical/execution-result.json：部署、启动、核心流程和测试套件必须分别给出状态。
- technical/stages.json、technical/TECHNICAL_REPORT.md、technical/logs/ 下的证据。
- capability-matrix.json 与 usage-playbook.json，每个用户能力或步骤均需验证状态和证据。usage-playbook.json 必须包含 representativeExample：根据当前项目类型和核心用户旅程自行选择一个贴近真实用途的具体例子，包含项目上下文、用户目标、操作步骤、用户可见结果和验证状态。
- comparison.json：只能做类别比较，未直接对比不得评价具体竞品。

## 示例选择规则
- 示例必须由你根据仓库实际用途决定，优先使用 README、官方示例、CLI/API 入口或核心用户旅程中最接近真实用户工作的场景。
- 不要固定使用贪吃蛇、Todo、Hello World 等通用例子；只有仓库本身就是游戏、Todo 工具或教学项目时才可以使用对应例子。
- 如果无法安全执行真实例子，仍生成最贴切的文档型例子，并明确标记为 DOCUMENTATION_ONLY 或 NOT_TESTED，不得虚构成功结果。

旧版兼容输出 report.md、result.json、USAGE_GUIDE.md 可以写入，但不得作为唯一结果。最终 USER_REPORT.md 由 Runner 从结构化证据生成。
`;
}

function packageFiles(bundle, packageDir) {
  const plan = bundle.plan ?? {};
  const type = projectType(bundle);
  const assessment = bundle.assessment?.assessment_json ? JSON.parse(bundle.assessment.assessment_json) : {};
  const profile = {
    schemaVersion: 1, projectType: type, productForm: type === 'AI_AGENT' ? ['CLI'] : [],
    primaryUseCases: Array.isArray(assessment.primaryUseCases) ? assessment.primaryUseCases : [], targetUsers: [],
    runtime: { language: bundle.repo?.language || 'Unknown', packageManager: null, containerSupport: plan.strategy?.includes('DOCKER') || false, binaryDistribution: false },
    requirements: { gpu: false, database: false, credentials: Boolean(plan.requirements?.credentials?.length), externalNetwork: Boolean(plan.requirements?.networkDuringBuild), externalServices: [] },
    detectedEntrypoints: [], evidenceSources: ['README', 'repository metadata'],
  };
  const initial = {
    schemaVersion: 1,
    deploymentValue: { level: 'WORTH_TRYING', label: '值得试用', summary: '基于仓库资料的部署前判断，仍需本地用户旅程验证。', reasons: [] },
    deploymentDifficulty: { level: 'MEDIUM', label: '中等', summary: '具体难度以本地执行证据为准。' },
    testability: { level: 'PARTIAL', label: '部分可自动测试', summary: '核心能力可能受环境或凭据限制。' },
    risk: { level: 'MEDIUM', label: '中等', summary: '仅在隔离工作区执行并遵守权限策略。' },
    recommendedAction: 'AGENT_ASSISTED_TEST', evidenceLevel: 'DOCUMENTATION_AND_REPOSITORY_ANALYSIS',
  };
  const testPlan = {
    schemaVersion: 1,
    coreUserJourneys: [
      { id: 'first-run', title: '首次安装并确认工具可用', importance: 'CORE', goal: '完成安装后可发现主要入口', preconditions: [], steps: ['构建或安装', '运行主要入口', '确认用户可见结果'], successCriteria: ['进程正常退出', '无阻断级错误'] },
      { id: 'primary-workflow', title: '完成核心业务任务', importance: 'CORE', goal: '通过项目最主要能力完成真实任务', preconditions: [], steps: ['准备安全样例', '执行核心流程', '检查用户结果'], successCriteria: ['产生预期用户结果'] },
    ], supportingChecks: ['环境诊断', '错误处理', '停止和清理'],
  };
  writeJson(path.join(packageDir, 'task.json'), { schemaVersion: 1, taskId: bundle.task.id, repository: { upstream: bundle.repo?.full_name || '', fork: bundle.project?.fork_full_name || '', commitSha: bundle.project?.upstream_commit_sha || 'HEAD', testBranch: bundle.project?.test_branch || null }, requestedTestLevel: 'USER_FUNCTION_TEST', maxRepairIterations: bundle.task.max_repair_iterations ?? 3, allowModification: bundle.task.allow_modification === 1, allowCommit: bundle.task.allow_commit === 1, allowPush: false, keepDeploymentAfterTest: false });
  writeJson(path.join(packageDir, 'project-profile.json'), profile);
  writeJson(path.join(packageDir, 'initial-assessment.json'), initial);
  writeJson(path.join(packageDir, 'deployment-plan.json'), { schemaVersion: 1, ...plan });
  writeJson(path.join(packageDir, 'test-plan.json'), testPlan);
  writeJson(path.join(packageDir, 'policy.json'), { ...DEFAULT_POLICY, allowModification: bundle.task?.allow_modification === 1, allowCommit: bundle.task?.allow_commit === 1 });
  writeJson(path.join(packageDir, 'environment.json'), { schemaVersion: 1, hostPlatform: process.platform, architecture: process.arch, dockerAvailable: false, dockerComposeAvailable: false, gitAvailable: true, gpuAvailable: false, availableToolchains: {}, preferredExecution: 'workspace_isolation', portAllocation: 'dynamic' });
  fs.writeFileSync(path.join(packageDir, 'verification.yaml'), `schemaVersion: 1\nprojectType: ${type}\nrequiredJourneys:\n  - first-run\n  - primary-workflow\nchecks:\n  - id: process-start\n    type: process\n    required: true\n  - id: primary-workflow\n    type: user_journey\n    required: true\nevidence:\n  collect:\n    - stdout\n    - stderr\n    - logs\n    - screenshots\n    - changed_files\n    - exit_codes\n`, 'utf8');
  return { profile, initial, testPlan };
}

export function writeBundle(bundle, workspaceDir) {
  const inputDir = path.join(workspaceDir, 'input');
  const instructionsDir = path.join(workspaceDir, 'instructions');
  const outputDir = path.join(workspaceDir, 'output');
  const repoDir = path.join(workspaceDir, 'repo');
  const packageDir = path.join(outputDir, 'deployment-package');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(instructionsDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const { profile, initial, testPlan } = packageFiles(bundle, packageDir);
  // Input copies preserve the adapter contract while the deployment package is portable.
  for (const name of ['task.json', 'deployment-plan.json', 'policy.json', 'environment.json', 'verification.yaml']) fs.copyFileSync(path.join(packageDir, name), path.join(inputDir, name));
  writeJson(path.join(inputDir, 'project-profile.json'), profile);
  writeJson(path.join(inputDir, 'initial-assessment.json'), initial);
  writeJson(path.join(inputDir, 'test-plan.json'), testPlan);
  fs.writeFileSync(path.join(packageDir, 'AGENT_TASK.md'), taskInstructions({ repoDir, outputDir, packageDir }), 'utf8');
  fs.writeFileSync(path.join(instructionsDir, 'DEPLOYMENT_WORKFLOW.md'), taskInstructions({ repoDir, outputDir, packageDir }), 'utf8');
  return { inputDir, instructionsDir, outputDir, repoDir };
}
