# HotChasing

HotChasing 是一个本地部署的开源项目热点追踪平台。它从 GitHub 采集候选项目和趋势数据，按统一分类体系生成中文日报与经典热门榜单，帮助团队持续发现值得关注的工具和技术方向。

## 功能

- **热点日报**：采集近期热门项目，按热度评分生成每日精选；支持历史归档、日期和分类筛选。
- **实时趋势**：展示 GitHub Trending 的今日、本周和本月项目。
- **Top100**：综合采用度、长期活跃度、生态、社区、工程成熟度和当前热度，生成经典热门项目榜单。
- **统一分类**：日报与 Top100 共用 AI 优先、规则兜底的分类流程，保证分类口径一致。
- **中文摘要与语义重排**：可使用配置的 AI 服务生成项目摘要，并对已加载结果进行语义重排。
- **本地数据持久化**：Express 和 SQLite 运行在 Docker 容器内，数据保存在本机 Docker 卷中。

## 架构

```text
Browser
  -> http://localhost:8080
  -> Nginx frontend container
  -> /api/* reverse proxy
  -> Express + SQLite backend container
  -> GitHub API / GitHub Trending RSS / configured AI provider
```

## 快速启动

### 前置条件

- Windows 10/11
- 已安装并启动 Docker Desktop

### 一键启动

双击根目录的 [Start-HotChasing.cmd](Start-HotChasing.cmd)。启动器会：

1. 检查 Docker Desktop 是否可用。
2. 启动 `frontend` 和 `backend` 两个 Docker Compose 服务。
3. 等待健康检查通过后自动打开 `http://localhost:8080`。

首次启动或容器未创建时，Docker Compose 会按 `docker-compose.yml` 创建容器；已有容器时只会启动已有服务，不会清空数据。

也可以在项目根目录手动执行：

```powershell
docker compose up -d
```

## 更新代码后重建

源代码更新不会自动进入已有容器。重新构建并启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-HotChasing.ps1 -Rebuild
```

或执行：

```powershell
docker compose up --build -d
```

Docker Hub 网络不可用时，构建可能因基础镜像拉取失败而中断；网络恢复后再次运行重建命令即可。

## 配置与数据

- 在应用的设置页面配置 GitHub Token 和 AI 服务。不要把密钥写入源码、README 或提交到仓库。
- 后端 SQLite 数据库和加密密钥位于 Docker 卷 `backend-data`，容器内路径为 `/app/data`。
- `docker compose down` 会删除容器但保留数据卷；再次 `up -d` 后数据仍会恢复。
- **不要执行 `docker compose down -v`**，除非确认要删除全部本地数据和加密密钥。

## 运维命令

```powershell
# 查看服务状态
docker compose ps

# 检查应用健康状态
Invoke-RestMethod http://localhost:8080/api/health

# 查看日志
docker compose logs -f frontend
docker compose logs -f backend

# 停止服务，保留数据
docker compose stop

# 重新启动已停止服务
docker compose start
```

健康检查正常时会返回：

```json
{"status":"ok"}
```

## 开源与使用声明

- 本项目依据 [MIT License](LICENSE) 发布。使用、修改和再发布时，请保留适用的版权与许可证声明。
- 本项目包含基于 [GithubStarsManager](https://github.com/AmintaCCCP/GithubStarsManager) 衍生的代码；来源与归属说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 项目展示的数据来自 GitHub API、GitHub Trending RSS 和用户自行配置的 AI 服务。项目与 GitHub、相关开源项目及 AI 服务提供商不存在官方隶属、赞助或背书关系。
- 使用者应自行遵守 GitHub、AI 服务提供商及其他数据来源的服务条款、API 使用限制和适用法律，并对自己的 Token、API Key、代理配置及使用行为负责。
- 请勿将 Token、API Key、数据库、加密密钥或任何个人数据提交到公开仓库。AI 生成的分类、摘要和排序仅供信息整理与研究参考，应自行核验。
- 本项目按许可证所述以“现状”提供，不对数据完整性、实时性、可用性或任何使用结果作出保证。

## 开发与验证

前端和后端分别位于项目根目录与 `server/`。修改后可运行：

```powershell
# 前端
npm run build
npm run test:run

# 后端
cd server
npm run build
npm test
```

生产运行以 Docker Compose 为准。提交或交付前应完成受影响模块的构建与测试。
