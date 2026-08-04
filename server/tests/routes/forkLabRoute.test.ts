import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 本地 Node 与容器内 Node ABI 不同，better-sqlite3 原生绑定不可用，
// 这里用极简内存实现模拟服务用到的 SQL 子集。
class FakeDb {
  repositories = new Map<number, Record<string, unknown>>();
  forkWorkspace = new Map<string, Record<string, unknown>>();
  assessments = new Map<number, Record<string, unknown>>();
  plans = new Map<string, Record<string, unknown>>();

  prepare(sql: string): {
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
    all: () => Record<string, unknown>[];
    run: (...params: unknown[]) => void;
  } {
    return {
      get: (...params) => {
        if (sql.startsWith('SELECT * FROM repositories WHERE id=?')) return this.repositories.get(params[0] as number);
        if (sql.includes('FROM fork_workspace_projects WHERE repo_id=?')) return [...this.forkWorkspace.values()].find((row) => row.repo_id === params[0]);
        if (sql.includes('FROM fork_workspace_projects WHERE id=?')) return this.forkWorkspace.get(params[0] as string);
        if (sql.includes('FROM deployment_assessments WHERE repo_id=?')) return this.assessments.get(params[0] as number);
        if (sql.includes('FROM deployment_plans WHERE workspace_project_id=?')) return [...this.plans.values()].find((row) => row.workspace_project_id === params[0]);
        return undefined;
      },
      all: () => {
        if (sql.includes('FROM fork_workspace_projects ORDER BY selected_at DESC')) {
          return [...this.forkWorkspace.values()].sort((a, b) => String(b.selected_at).localeCompare(String(a.selected_at)));
        }
        return [];
      },
      run: (...params) => {
        if (sql.startsWith('INSERT INTO fork_workspace_projects')) {
          const [id, repoId, source, upstream, forkStatus, status, selectedAt] = params as [string, number, string, string, string, string, string];
          this.forkWorkspace.set(id, { id, repo_id: repoId, source, upstream_full_name: upstream, fork_status: forkStatus, project_status: status, selected_at: selectedAt, fork_full_name: null, upstream_commit_sha: null, test_branch: null, forked_at: null, archived_at: null });
          return;
        }
        if (sql.startsWith('INSERT INTO deployment_assessments')) {
          const [repoId, value, difficulty, testability, risk, level, strategy, json, hash, aiConfig, confidence, assessedAt] = params as [number, number, number, number, number, string, string, string, string, string | null, number | null, string];
          this.assessments.set(repoId, { repo_id: repoId, value_score: value, difficulty_score: difficulty, testability_score: testability, risk_score: risk, recommended_level: level, recommended_strategy: strategy, assessment_json: json, source_hash: hash, ai_config_id: aiConfig, confidence, assessed_at: assessedAt });
          return;
        }
        if (sql.startsWith('INSERT INTO deployment_plans')) {
          const [id, projectId, json, source, generatedAt, updatedAt] = params as [string, string, string, string, string, string];
          this.plans.set(id, { id, workspace_project_id: projectId, plan_json: json, plan_source: source, plan_version: 1, locked: 0, generated_at: generatedAt, updated_at: updatedAt });
          return;
        }
        if (sql.startsWith('UPDATE fork_workspace_projects SET project_status=? WHERE id=?')) {
          const [status, id] = params as [string, string];
          const row = this.forkWorkspace.get(id);
          if (row) row.project_status = status;
          return;
        }
        if (sql.startsWith('UPDATE deployment_plans SET locked=1')) {
          const [updatedAt, projectId] = params as [string, string];
          const row = [...this.plans.values()].find((p) => p.workspace_project_id === projectId);
          if (row) { row.locked = 1; row.updated_at = updatedAt; }
          return;
        }
        if (sql.startsWith('UPDATE deployment_plans SET locked=0')) {
          const [updatedAt, projectId] = params as [string, string];
          const row = [...this.plans.values()].find((p) => p.workspace_project_id === projectId);
          if (row) { row.locked = 0; row.updated_at = updatedAt; }
          return;
        }
        if (sql.startsWith('UPDATE deployment_plans SET plan_json=?,plan_source=?,plan_version=plan_version+1,generated_at=?,updated_at=? WHERE workspace_project_id=?')) {
          const [json, source, generatedAt, updatedAt, projectId] = params as [string, string, string, string, string];
          const row = [...this.plans.values()].find((p) => p.workspace_project_id === projectId);
          if (row) { row.plan_json = json; row.plan_source = source; row.plan_version = Number(row.plan_version) + 1; row.generated_at = generatedAt; row.updated_at = updatedAt; }
          return;
        }
        if (sql.startsWith('UPDATE deployment_plans SET plan_json=?,plan_source=?,plan_version=plan_version+1,updated_at=? WHERE workspace_project_id=?')) {
          const [json, source, updatedAt, projectId] = params as [string, string, string, string];
          const row = [...this.plans.values()].find((p) => p.workspace_project_id === projectId);
          if (row) { row.plan_json = json; row.plan_source = source; row.plan_version = Number(row.plan_version) + 1; row.updated_at = updatedAt; }
          return;
        }
        if (sql.startsWith('DELETE FROM deployment_plans WHERE workspace_project_id=?')) {
          const [projectId] = params as [string];
          for (const [key, row] of this.plans) { if (row.workspace_project_id === projectId) this.plans.delete(key); }
          return;
        }
        if (sql.startsWith('DELETE FROM fork_workspace_projects WHERE id=?')) {
          this.forkWorkspace.delete(params[0] as string);
          return;
        }
      },
    };
  }

  transaction(fn: () => void) {
    return () => fn();
  }
}

let fakeDb: FakeDb;
vi.mock('../../src/db/connection.js', () => ({
  getDb: () => fakeDb,
}));

vi.mock('../../src/discovery/aiGateway.js', () => ({
  generateDeploymentAssessment: vi.fn(async () => ({
    valueScore: 84,
    difficultyScore: 42,
    testabilityScore: 78,
    riskScore: 21,
    recommendedLevel: 'AGENT_ASSISTED_TEST',
    recommendedMethod: 'OFFICIAL_DOCKERFILE',
    assessmentJson: {
      deploymentValueScore: 84,
      deploymentDifficultyScore: 42,
      testabilityScore: 78,
      riskScore: 21,
      recommendedLevel: 'AGENT_ASSISTED_TEST',
      recommendedMethod: 'OFFICIAL_DOCKERFILE',
      estimatedResources: { cpu: 2, memoryMb: 2048, diskMb: 4096, gpuRequired: false },
      requirements: { database: false, externalApi: false, credentials: false, accountLogin: false, networkDuringBuild: true, networkDuringRun: false },
      valueReasons: ['功能具有明确本地使用价值'],
      difficultyReasons: ['需要构建 Node.js 应用'],
      riskReasons: [],
      detectedFiles: ['Dockerfile', 'package.json'],
      suspectedPorts: [3000],
      suspectedCommands: ['npm run build', 'npm run start'],
      confidence: 0.88,
    },
    aiConfigId: 'cfg-1',
    confidence: 0.88,
    source: 'ai' as const,
  })),
  generateDeploymentPlan: vi.fn(async () => ({
    planJson: {
      schemaVersion: 1,
      strategy: 'OFFICIAL_DOCKERFILE',
      summary: '使用官方 Dockerfile 构建并启动 Web 服务',
      testLevel: 'L2',
      estimatedResources: { cpu: 2, memoryMb: 2048, diskMb: 4096 },
      requirements: { environmentVariables: [], credentials: [], database: false, networkDuringBuild: true, networkDuringRun: false },
      steps: [
        { id: 'build', type: 'docker_build', context: '.', dockerfile: 'Dockerfile' },
        { id: 'start', type: 'docker_run', containerPort: 3000, hostPort: 'dynamic' },
        { id: 'verify-home', type: 'http_check', path: '/', expectedStatus: 200 },
      ],
      blockers: [],
      needsUserApproval: false,
    },
    summary: '使用官方 Dockerfile 构建并启动 Web 服务',
    source: 'ai' as const,
    model: 'test-model',
  })),
}));

vi.mock('../../src/discovery/classificationService.js', () => ({
  fetchRepositoryEnrichment: vi.fn(async () => ({ readme: '# demo', architecture: 'file:Dockerfile\nfile:package.json' })),
}));

const { default: forkLabRouter } = await import('../../src/routes/forkLab.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(forkLabRouter);
  return app;
}

function seedRepository(id: number, fullName: string, stars = 1200) {
  fakeDb.repositories.set(id, {
    id,
    name: fullName.split('/')[1],
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: 'A demo repository.',
    stargazers_count: stars,
    forks_count: 10,
    language: 'TypeScript',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    pushed_at: '2026-07-01T00:00:00.000Z',
    owner_login: fullName.split('/')[0],
    owner_avatar_url: '',
    topics: '[]',
    license: 'MIT',
  });
}

describe('Fork lab M1/M2', () => {
  beforeEach(() => {
    fakeDb = new FakeDb();
    seedRepository(1, 'owner/demo-app');
    seedRepository(2, 'owner/second-app');
  });

  it('creates a project and rejects duplicates with the existing record', async () => {
    const app = createTestApp();
    const create = await request(app).post('/api/fork-lab/projects').send({ repoId: 1, source: 'digest' }).expect(201);
    expect(create.body).toMatchObject({ created: true, alreadyExists: false, project: { repo_id: 1, source: 'digest', upstream_full_name: 'owner/demo-app', fork_status: 'NOT_REQUESTED', project_status: 'SELECTED' } });

    const duplicate = await request(app).post('/api/fork-lab/projects').send({ repoId: 1, source: 'top100' }).expect(200);
    expect(duplicate.body).toMatchObject({ created: false, alreadyExists: true, project: { repo_id: 1 } });
    expect(fakeDb.forkWorkspace.size).toBe(1);
  });

  it('rejects unknown repositories', async () => {
    const app = createTestApp();
    const response = await request(app).post('/api/fork-lab/projects').send({ repoId: 999, source: 'manual' }).expect(404);
    expect(response.body.code).toBe('REPOSITORY_NOT_FOUND');
  });

  it('lists projects and returns assessment and plan views', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/fork-lab/projects').send({ repoId: 2, source: 'top100' }).expect(201);
    const projectId = created.body.project.id;
    await request(app).post(`/api/fork-lab/projects/${projectId}/assessment`).expect(200);
    await request(app).post(`/api/fork-lab/projects/${projectId}/plan`).expect(200);

    const list = await request(app).get('/api/fork-lab/projects').expect(200);
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0].assessment).toBeTruthy();
    expect(list.body.projects[0].plan).toMatchObject({ plan_source: 'ai' });
    expect(list.body.projects[0].repo.full_name).toBe('owner/second-app');
  });

  it('caches deployment assessment until the source hash changes', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/fork-lab/projects').send({ repoId: 1, source: 'digest' }).expect(201);
    const projectId = created.body.project.id;

    const first = await request(app).post(`/api/fork-lab/projects/${projectId}/assessment`).expect(200);
    expect(first.body.cached).toBe(false);

    const second = await request(app).post(`/api/fork-lab/projects/${projectId}/assessment`).expect(200);
    expect(second.body.cached).toBe(true);
    expect(second.body.assessment.recommended_level).toBe('AGENT_ASSISTED_TEST');

    const forced = await request(app).post(`/api/fork-lab/projects/${projectId}/assessment`).send({ force: true }).expect(200);
    expect(forced.body.cached).toBe(false);
  });

  it('requires assessment before generating a plan', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/fork-lab/projects').send({ repoId: 1, source: 'digest' }).expect(201);
    const response = await request(app).post(`/api/fork-lab/projects/${created.body.project.id}/plan`).expect(409);
    expect(response.body.code).toBe('ASSESSMENT_REQUIRED');
  });

  it('locks a plan, rejects edits, and can unlock it again', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/fork-lab/projects').send({ repoId: 1, source: 'digest' }).expect(201);
    const projectId = created.body.project.id;
    await request(app).post(`/api/fork-lab/projects/${projectId}/assessment`).expect(200);
    await request(app).post(`/api/fork-lab/projects/${projectId}/plan`).expect(200);

    const edited = await request(app).put(`/api/fork-lab/projects/${projectId}/plan`).send({ plan: { summary: '手动编辑后的计划', steps: [{ id: 's', type: 'command', command: 'echo hi' }] } }).expect(200);
    expect(edited.body.plan.plan_source).toBe('manual');

    const locked = await request(app).post(`/api/fork-lab/projects/${projectId}/plan/lock`).expect(200);
    expect(locked.body.plan.locked).toBe(1);

    const afterLock = await request(app).put(`/api/fork-lab/projects/${projectId}/plan`).send({ plan: { summary: 'x' } }).expect(409);
    expect(afterLock.body.code).toBe('PLAN_LOCKED');

    const unlocked = await request(app).post(`/api/fork-lab/projects/${projectId}/plan/unlock`).expect(200);
    expect(unlocked.body.plan.locked).toBe(0);
    await request(app).put(`/api/fork-lab/projects/${projectId}/plan`).send({ plan: { summary: '解锁后计划', steps: [{ id: 's', type: 'command', command: 'echo hi' }] } }).expect(200);
  });

  it('removes a project together with its plans but keeps the assessment', async () => {
    const app = createTestApp();
    const created = await request(app).post('/api/fork-lab/projects').send({ repoId: 1, source: 'digest' }).expect(201);
    const projectId = created.body.project.id;
    await request(app).post(`/api/fork-lab/projects/${projectId}/assessment`).expect(200);
    await request(app).post(`/api/fork-lab/projects/${projectId}/plan`).expect(200);

    await request(app).delete(`/api/fork-lab/projects/${projectId}`).expect(200);
    expect(fakeDb.forkWorkspace.size).toBe(0);
    expect(fakeDb.plans.size).toBe(0);
    expect(fakeDb.assessments.size).toBe(1);
  });
});
