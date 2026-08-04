# HotChasing 本地 Runner

宿主机上的独立进程，负责领取部署任务、准备工作区、启动 Agent、校验结果并回传。

**约束（与方案一致）**：Runner 运行在宿主机，不放入 backend 容器；backend 不挂载 Docker Socket、不直接执行陌生项目代码。

## 前置条件
- Node.js 18+（宿主机）
- 已启动 HotChasing 后端（`http://localhost:8080`）
- `git`（clone 用）
- 可选 `docker`（HTTP 校验）
- 可选 `opencode` CLI（`AGENT=opencode` 时）

## 使用
```powershell
# 1. 注册 Runner（生成 runner/runner.json）
node runner/register.mjs

# 2. 启动 Runner（默认 Manual 模式）
node runner/runner.mjs

# 3. 用 OpenCode Agent 模式
$env:AGENT="opencode"; node runner/runner.mjs
```

## 环境变量
| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BACKEND_URL` | `http://localhost:8080/api` | 后端地址 |
| `WORKSPACE_ROOT` | `<runner>/workspace` | 任务工作区根目录 |
| `GITHUB_TOKEN` | 空 | 用于 clone 私有仓库/写操作（公开仓库无需） |
| `AGENT` | `manual` | `manual`、`opencode`、`claude-code` 或 `codex` |
| `AGENT_TIMEOUT_MS` | 1800000 | Agent 超时（毫秒） |
| `MAX_REPAIR_ITERATIONS` | 1 | 修复轮次上限 |
| `SKIP_CLONE` | `false` | 跳过 clone（调试用） |
| `API_SECRET` | 空 | 后端启用了 API_SECRET 时填写 |

## 工作区结构
```
workspace/<task-id>/
├── repo/                        # clone 的仓库（固定 commit + 测试分支）
├── input/
│   ├── task.json
│   ├── assessment.json
│   ├── deployment-plan.json
│   ├── policy.json
│   ├── environment.json
│   └── verification.yaml
├── instructions/
│   └── DEPLOYMENT_WORKFLOW.md   # 给 Agent 的统一任务说明
└── output/                      # Agent 结果（result.json/report.md/patch.diff）
```

## Manual 模式
Runner 生成任务包并打印路径；用户手动在 `repo/` 中执行 Agent，完成后在
`output/result.json` 写入：
```json
{ "status": "passed", "port": 3000, "summary": "..." }
```
Runner 校验通过后回传 `COMPLETED`。

## 说明
- Runner 在 Agent 执行期间持续发送心跳；任务执行时间不会导致 Runner 被误判为离线。
- 最终成功以 Runner 校验为准（`result.json.status === "passed"` + `report.md`；仅计划要求 HTTP 校验时探测端口）。
- Runner 离线后，已领取任务会在 backend 中标为 `BLOCKED / RUNNER_OFFLINE`，不会被新的 Runner 自动续跑；只能由用户在前端手动重试。
- 这是 M5/M6 的第一版链路；Docker 容器管理、批量并发与本地启停（M7/M8）后续补充。
