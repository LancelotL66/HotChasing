# HotChasing

HotChasing 是一个本地优先的开源项目发现与研究工作台。它把 GitHub 项目采集、热点日报、历史项目更新、AI 分类与摘要、趋势榜单、README 阅读和本地部署验证放在同一个工作流里。

HotChasing 适合需要持续追踪开源生态的个人开发者、研究者和技术团队：先发现项目，再理解项目，最后验证项目是否值得部署和使用。

## 核心能力

- **热点日报**：按频道采集近期项目，生成可回溯的每日精选和历史归档。
- **历史项目更新**：日报完成后后台轮换检查已有项目；只有代码提交时间变化时才读取 README，README 未变化时只同步仓库元数据。
- **趋势与 Top100**：结合短期热度、长期采用度、生态、社区和工程成熟度观察项目变化。
- **AI 分类与摘要**：AI 优先、规则兜底；摘要、标签和分类结果保存在本地数据库。
- **语义搜索**：对当前已加载的日报或项目集合进行意图扩展和相关性检索。
- **README 阅读**：支持目录、双语显示、字号调整、翻译和项目详情阅读。
- **Fork 实验室**：收集项目、同步上游、生成部署分析和本地测试流程。
- **本地测试报告**：保存用户报告、功能验证、部署文件、日志和测试证据。
- **本地优先存储**：SQLite 数据库和加密配置由 Docker 数据卷持久化保存。

## 运行方式

### 前置条件

- Windows 10/11
- Docker Desktop
- GitHub Personal Access Token
- 可选：OpenAI、Claude、DeepSeek、Ollama 或其他 OpenAI-compatible AI 服务

### Docker 启动

双击根目录的 `Start-HotChasing.cmd`，或手动执行：

```powershell
docker compose up -d
```

启动后访问：`http://localhost:8080`

首次启动会创建 `hotchasing_backend-data` 数据卷。停止或重新创建容器不会删除数据；除非明确要清空全部数据，不要执行：

```powershell
docker compose down -v
```

### 更新代码后重建

```powershell
docker compose up --build -d
```

Docker 基础镜像拉取失败时，等待网络恢复后重新执行即可。

## 桌面客户端

开发模式：

```powershell
npm install
npm run electron:dev
```

生成 Windows 安装包：

```powershell
npm run build:desktop
```

安装包输出为根目录的 `HotChasing-Setup.exe`。桌面客户端默认加载本地构建的前端，并通过 `http://localhost:8080/api` 访问 Docker backend。

## 配置与数据

在应用的“设置”中配置 GitHub Token、AI 服务、代理、WebDAV 和向量搜索。密钥由后端加密保存，不要提交到 Git、README、镜像或日志。

数据库位于 Docker 卷：

```text
卷名：hotchasing_backend-data
容器路径：/app/data
```

常用运维命令：

```powershell
docker compose ps
Invoke-RestMethod http://localhost:8080/api/health
docker compose logs -f backend
docker compose stop
docker compose start
```

## 系统结构

```text
HotChasing Web / Electron
        |
        | HTTP /api
        v
Nginx frontend container
        |
        v
Express backend + SQLite volume
        |
        +-- GitHub API / Trending RSS
        +-- Configured AI provider
        +-- Fork Lab / local testing services
```

主要目录：

```text
src/          React 前端、状态管理和服务适配器
server/       Express API、SQLite、日报和 Fork 实验室
electron/     Electron 主进程和桌面桥接
runner/       本地 Agent 测试 Runner
cloudflare-worker/ 向量搜索 Worker
scripts/      桌面构建和维护脚本
```

## 开发与验证

```powershell
# 前端
npm run build
npm run test:run

# 后端
cd server
npm run build
npm test
```

## 项目边界与许可

HotChasing 是独立维护和持续改造的产品项目，当前代码、界面、日报流程、Fork 实验室、本地测试系统和文档由本项目维护。

项目仍包含来自第三方项目的衍生代码和依赖。第三方许可、版权和归属声明必须保留，详见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。重新包装产品名称不等于取消上游许可义务。

HotChasing 不隶属于 GitHub，也不代表 GitHub、AI 服务商或被收录项目。项目数据受 GitHub API、RSS、AI 服务和网络环境影响；AI 分类、摘要、评分和部署建议应由使用者自行核验。

## 发布前检查

1. 确认 README、应用标题、Electron 产品名和 Docker 镜像名均为 HotChasing。
2. 确认第三方许可证和归属文件仍然存在。
3. 确认没有提交 Token、API Key、数据库或 Docker 卷内容。
4. 执行前端和后端构建及受影响模块测试。
5. 发布桌面包前先备份 `hotchasing_backend-data` 数据卷。
