# HotChasing AI Handover

## Purpose

This document is a working handover for the next AI agent. Read it before changing the HotChasing daily digest, Top100, classification, or Docker deployment paths.

## Workspace Rules

- Work only inside this project directory and its children unless the user explicitly provides another path.
- Do not inspect adjacent directories.
- The worktree may contain user changes. Do not revert unrelated changes.
- Use `apply_patch` for source edits.
- Do not commit, push, or create a PR unless explicitly asked.
- Prefer small changes that preserve existing UI and data behavior.

## Current Architecture

```text
Browser
  -> http://localhost:8080
  -> Docker frontend container (Nginx + built React files)
  -> /api/* reverse proxy
  -> Docker backend container (Node.js / Express + SQLite)
  -> GitHub Search / GitHub repository API / GitHub Trending RSS / configured AI provider
```

Docker Compose services are defined in `docker-compose.yml`:

- `frontend`: built from the root `Dockerfile`; Nginx serves the React build and proxies `/api/*` to `backend:3000`.
- `backend`: built from `server/Dockerfile`; Express server and SQLite.
- `backend-data` volume: mounted at `/app/data`; persists database and encryption key.

Important data path inside the backend container:

```text
/app/data/data.db
```

## Start And Verify

From the project root:

```powershell
docker compose up -d
docker compose ps
Invoke-RestMethod http://localhost:8080/api/health
```

Expected health response:

```json
{"status":"ok"}
```

Normal rebuild command:

```powershell
docker compose up --build -d
```

Do not use `docker compose down -v` unless data deletion is intended. It removes the SQLite volume.

## Current Runtime Note

Docker Hub connectivity has intermittently failed with TLS/EOF errors while resolving `node:22-alpine` or `nginx:alpine`. During those failures, verified `dist` output was copied into running containers with `docker cp`.

This means source code is the authoritative desired state, while a future successful `docker compose up --build -d` is needed to make local images permanently contain all changes. Do not assume a container restart preserves files copied directly into a container.

## Main Product Areas

### Hotspot / Daily Digest

Frontend: `src/components/DailyDigestView.tsx`

The top-level `热点` page contains:

- `今日精选`: persisted daily digest, archive selection, date filtering, category filtering, README modal, GitHub Star, and AI semantic reranking.
- `实时趋势`: embeds `DiscoveryView` in `trendingOnly` mode. It retains only GitHub Trending RSS with today/week/month ranges.

Daily update flow:

```text
POST /api/discovery/run
POST /api/digests/generate
```

Relevant backend files:

- `server/src/routes/discovery.ts`: GitHub Search candidate collection.
- `server/src/routes/digests.ts`: daily selection, classification, summary generation, archive persistence.
- `server/src/discovery/scoringService.ts`: daily trending score formula.

Daily candidate and selection behavior:

- Candidate projects are created within the last 120 days.
- They must have a discovery snapshot on the selected digest UTC date.
- Discovery uses multiple GitHub Search channels. Most require at least 20 stars; the new-and-notable channel requires at least 50.
- Personal GitHub Star repositories are not daily candidates.
- Candidate order: `final_score DESC`, then discovery channel rank ascending, then update time descending.
- Default digest size is 30; at most 48 candidates are examined.
- It tries to select one candidate for each primary category before filling remaining slots by order.
- `其他 / 待分类` remains a primary category and therefore can currently receive coverage selection.

Daily score formula:

- Fewer than two snapshots: score is 0.
- 24-hour star velocity: `log(1 + max(0, stars24h)) * 30`.
- 7-day average star velocity: `log(1 + max(0, stars7d / 7)) * 20`.
- Positive channel rank gain: `max(0, previousRanking - ranking) * 10`.
- Updated in last 14 days: +10.
- Released in last 30 days: +10.

`final_score` currently equals this trending score. Candidates are not automatically rescored during every collection; keep this limitation in mind before changing ranking claims.

### Top100

Frontend: `src/components/Top100View.tsx`

Backend:

- `server/src/routes/classicRanking.ts`: endpoint, candidate acquisition, summaries, response.
- `server/src/classic-ranking/rankingService.ts`: scoring, classification, snapshots.

Endpoints:

```text
POST /api/classic-ranking/generate-top100
GET  /api/classic-ranking/top100
GET  /api/classic-ranking/top100/:date
```

Candidate pools:

- High adoption: `stars >= 10000`.
- Recent hot: created in the last year and `stars >= 100`.

Top100 score weights:

- Adoption: 20%.
- Longevity: 10%.
- Ecosystem: 15%.
- Community: 10%.
- Engineering maturity: 10%.
- Current heat: 35%.

Current heat composition:

- Recent update: 45%.
- Project freshness: 25%.
- Adjacent snapshot star growth: 30%.

Top100 UI behavior:

- All projects render in ranking order.
- Semantic search only reranks loaded items. It does not update scores, snapshots, or rankings.
- Update UI shows staged progress and last successful update time. The percentage during AI work is intentionally approximate because the API is one long request.

## Shared Classification Contract

Daily Digest and Top100 MUST use the same classification chain. Do not create page-specific category logic.

Shared files:

- `server/src/discovery/classificationService.ts`
- `server/src/discovery/aiGateway.ts`

Shared flow:

```text
Description + Topics + language + license + README + root directory architecture
  -> AI classification
  -> rules only if AI is unavailable, invalid, or fails
```

The currently allowed primary categories are:

```text
AI 与 Agent
开发者工具
数据与数据库
基础设施与 DevOps
效率与自动化
设计与内容创作
安全与隐私
桌面与移动应用
学习与研究
其他 / 待分类
```

Do not reintroduce `商业与金融` or `待人工确认`.

User-provided classifications were converted into short shared boundaries, not permanent per-repository locks. The AI remains the final classifier. The compact AI guidance is in `classificationGuidance` in `server/src/discovery/aiGateway.ts`:

- Frameworks, runtimes, compilers, game engines, and visualization libraries -> `基础设施与 DevOps`.
- Vue -> `数据与数据库`.
- Code tools, algorithm implementations, and engineering configuration -> `开发者工具`.
- Courses, tutorials, learning paths, and resource indexes -> `学习与研究`.

The rules fallback includes matching boundaries. Keep both the AI guidance and fallback aligned, but keep prompt guidance short to control token usage.

Classification cache behavior:

- `classificationSourceHash()` is based on taxonomy version and classification inputs.
- Current version marker: `taxonomy-ai-boundaries-v5`.
- If inputs are unchanged and a valid category exists, Top100 reuses the prior classification rather than calling AI again.
- Top100 classification and summary work use concurrency limit 4.

Important: AI output frequently violates the strict schema, especially `deploymentDifficulty`, `hotReasonTags`, and tag count bounds. This is expected to fall back to rules; do not let one invalid model response fail the full job.

## Progress And Timeout Behavior

Daily and Top100 have client-side staged progress bars. They do not represent exact backend item counts because the update API does not stream job progress.

Nginx proxy rules live in `nginx.conf.template`.

- `/api/` proxy timeout should be 900 seconds for first-time Top100 classification batches.
- A previous `50x.html` error page configuration caused a 300-second upstream timeout to appear as a browser 404 because the error page file did not exist. That configuration was removed.
- If users report an update 404, inspect Nginx logs first. It can be an upstream timeout rather than a missing Express route.

Useful commands:

```powershell
docker logs hotchasing-frontend-1 --tail 200
docker logs hotchasing-backend-1 --tail 200
```

## Key Frontend Files

- `src/App.tsx`: main view routing.
- `src/components/Header.tsx`: `趋势` is hidden; the former digest navigation label is `热点`.
- `src/components/DailyDigestView.tsx`: hotspot/digest UI, detailed selection explanation, progress, last update time, semantic search.
- `src/components/Top100View.tsx`: Top100 UI, progress, last update time, semantic search.
- `src/components/DiscoveryView.tsx`: original discovery UI; accepts `trendingOnly?: boolean` for embedded real-time trends.
- `src/services/digestApi.ts`: daily API client.
- `src/services/backendAdapter.ts`: determines the `/api` base URL.

## Key Backend Files

- `server/src/index.ts`: Express route registration.
- `server/src/routes/discovery.ts`: discovery collection and score endpoint.
- `server/src/routes/digests.ts`: digest generation and retrieval.
- `server/src/routes/classicRanking.ts`: Top100 endpoints.
- `server/src/classic-ranking/rankingService.ts`: Top100 score and cached classification.
- `server/src/discovery/classificationService.ts`: category list, hash, README/root listing retrieval, rule fallback.
- `server/src/discovery/aiGateway.ts`: configured AI access, schemas, summary and classification prompts.
- `server/src/db/migrations.ts`: schema migrations.

## Validation Commands

Frontend:

```powershell
npm run build
npm run test:run
```

Backend:

```powershell
cd server
npm run build
npm test
```

Expected recent results:

- Frontend: 144 tests passed.
- Backend: 73 tests passed, with 7 existing MCP tests skipped.
- Vite warns that the main bundle exceeds 2500 kB. This is existing and non-blocking.

## Known Constraints And Follow-ups

- Top100 update is still a synchronous HTTP request. First runs or changed source hashes can take several minutes despite concurrency limiting and caching.
- A real server-side job/status API would provide accurate progress and make updates resilient to browser disconnection. Do not implement it unless requested; it is larger than the current staged UI approach.
- GitHub unauthenticated search can rate limit. Daily discovery and Top100 candidate acquisition have partial fallback behavior, but do not fabricate historical data if GitHub fails.
- Do not repeatedly trigger Top100 updates during debugging: it consumes AI quota and can rate limit the provider.
- Direct `docker cp` deployment is temporary. Rebuild Compose images after Docker Hub connectivity is stable.

## Suggested First Checks For A New Task

1. Read this document and the target component/route.
2. Check current container status with `docker compose ps` and `/api/health`.
3. Inspect existing tests before changing selection or classification behavior.
4. Keep daily and Top100 classification behavior shared.
5. Build and test affected frontend/backend packages before deployment.
